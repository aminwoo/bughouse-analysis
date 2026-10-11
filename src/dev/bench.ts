// Dev-only: measures onnxruntime-web throughput for the network per backend.
type Ort = typeof import("onnxruntime-web");
const out = document.getElementById("out")!;
const log = (s: string) => { out.textContent += "\n" + s; console.log(s); };
const q = new URLSearchParams(location.search);

async function loadModel() {
  return new Uint8Array(await (await fetch("/engine/twin-s.onnx")).arrayBuffer());
}

async function bench(label: string, ort: Ort, ep: string, sizes: number[], extra: Record<string, unknown> = {}) {
  ort.env.wasm.numThreads = 1;
  const model = await loadModel();
  for (const b of sizes) {
    const session = await ort.InferenceSession.create(model, {
      executionProviders: [ep],
      graphOptimizationLevel: "all",
      freeDimensionOverrides: { batch: b },
      ...extra,
    });
    const x = new ort.Tensor("float32", new Float32Array(b * 74 * 64).map(() => Math.random()), [b, 74, 8, 8]);
    for (let i = 0; i < 3; i++) await session.run({ data: x });
    let n = 0;
    const t = performance.now();
    while (performance.now() - t < 1500) { await session.run({ data: x }); n++; }
    const ms = (performance.now() - t) / n;
    log(`${label} batch=${b}: ${ms.toFixed(1)} ms/call, ${(b * 1000 / ms).toFixed(0)} pos/s`);
    await session.release();
  }
}

async function benchCapture(ort: Ort, sizes: number[]) {
  const model = await loadModel();
  for (const b of sizes) {
    const session = await ort.InferenceSession.create(model, {
      executionProviders: ["webgpu"],
      graphOptimizationLevel: "all",
      freeDimensionOverrides: { batch: b },
      enableGraphCapture: true,
      preferredOutputLocation: "gpu-buffer",
    });
    const device = (await ort.env.webgpu.device) as GPUDevice;
    const bytes = b * 74 * 64 * 4;
    const inputBuffer = device.createBuffer({ size: bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
    const input = ort.Tensor.fromGpuBuffer(inputBuffer, { dataType: "float32", dims: [b, 74, 8, 8] });
    const data = new Float32Array(b * 74 * 64).map(() => Math.random());
    const runOnce = async () => {
      device.queue.writeBuffer(inputBuffer, 0, data);
      const res = await session.run({ data: input });
      const values = await Promise.all(session.outputNames.map((name) => res[name].getData(true)));
      return values;
    };
    for (let i = 0; i < 3; i++) await runOnce();
    let n = 0;
    const t = performance.now();
    while (performance.now() - t < 1500) { await runOnce(); n++; }
    const ms = (performance.now() - t) / n;
    log(`capture batch=${b}: ${ms.toFixed(1)} ms/call, ${(b * 1000 / ms).toFixed(0)} pos/s`);
    await session.release();
  }
}

const which = q.get("which") ?? "jsep";
const sizes = (q.get("sizes") ?? "8,32,64").split(",").map(Number);
try {
  if (which === "jsep") await bench("jsep-static", (await import("onnxruntime-web")) as unknown as Ort, "webgpu", sizes);
  if (which === "capture") await benchCapture((await import("onnxruntime-web")) as unknown as Ort, sizes);
  if (which === "wasm") await bench("wasm-1t", (await import("onnxruntime-web/wasm")) as unknown as Ort, "wasm", sizes);
} catch (e) {
  log("error: " + (e instanceof Error ? e.stack : String(e)));
}
log("done");
