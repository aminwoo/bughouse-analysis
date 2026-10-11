// Rewrites of an ONNX network in the browser, working on the protobuf wire
// format directly and copying every other field through untouched.
//
// convertToFp32: the published hivemind networks store FP16 weights.
// onnxruntime-web's CPU backend has no FP16 kernels and wraps every node in
// casts, so the CPU engine runs an FP32 copy. This mirrors hivemind's
// engine/scripts/convert_onnx_fp32.py: FP16 initializers and attribute tensors
// become FP32, FP16 value infos are retyped and Cast-to-FP16 nodes cast to FP32
// instead.
//
// splitsToSlices: onnxruntime-web's WebGPU backend has no FP16 Split kernel,
// so the FP16 network's Split nodes would run on the CPU and rule out graph
// capture. Each becomes one Slice per output.

const FLOAT = 1;
const INT64 = 7;
const FLOAT16 = 10;

const VARINT = 0;
const I64 = 1;
const LEN = 2;
const I32 = 5;

interface Field {
  num: number;
  wire: number;
  /** The whole field: key and value. */
  raw: Uint8Array;
  /** Varint value (approximate above 2^53, which only affects huge int64s). */
  int: number;
  /** Payload of a length-delimited field. */
  bytes: Uint8Array;
}

export interface NetworkTensorInfo {
  name: string;
  elemType: number;
  /** Dimension sizes; symbolic dimensions are null. */
  dims: (number | null)[];
}

export interface ConvertedNetwork {
  model: Uint8Array;
  inputs: NetworkTensorInfo[];
  outputs: NetworkTensorInfo[];
  /** Number of tensors, value infos and casts that were changed. */
  converted: number;
}

function readVarint(buf: Uint8Array, pos: number): [number, number] {
  let value = 0;
  let scale = 1;
  for (;;) {
    if (pos >= buf.length) throw new Error("truncated ONNX file");
    const byte = buf[pos++];
    value += (byte & 0x7f) * scale;
    if (byte < 0x80) return [value, pos];
    scale *= 128;
  }
}

function* fields(buf: Uint8Array): Generator<Field> {
  let pos = 0;
  while (pos < buf.length) {
    const start = pos;
    let key: number;
    [key, pos] = readVarint(buf, pos);
    const num = Math.floor(key / 8);
    const wire = key % 8;
    let int = 0;
    let bytes = buf.subarray(pos, pos);
    if (wire === VARINT) {
      [int, pos] = readVarint(buf, pos);
    } else if (wire === LEN) {
      let length: number;
      [length, pos] = readVarint(buf, pos);
      if (pos + length > buf.length) throw new Error("truncated ONNX file");
      bytes = buf.subarray(pos, pos + length);
      pos += length;
    } else if (wire === I64) {
      pos += 8;
    } else if (wire === I32) {
      pos += 4;
    } else {
      throw new Error(`unsupported protobuf wire type ${wire}`);
    }
    yield { num, wire, raw: buf.subarray(start, pos), int, bytes };
  }
}

function varint(value: number): number[] {
  const out: number[] = [];
  while (value >= 0x80) {
    out.push((value % 128) | 0x80);
    value = Math.floor(value / 128);
  }
  out.push(value);
  return out;
}

class Writer {
  private parts: Uint8Array[] = [];
  private size = 0;

  raw(bytes: Uint8Array) {
    this.parts.push(bytes);
    this.size += bytes.length;
  }
  varintField(num: number, value: number) {
    this.raw(Uint8Array.from([...varint(num * 8 + VARINT), ...varint(value)]));
  }
  bytesField(num: number, bytes: Uint8Array) {
    this.raw(Uint8Array.from([...varint(num * 8 + LEN), ...varint(bytes.length)]));
    this.raw(bytes);
  }
  finish(): Uint8Array {
    const out = new Uint8Array(this.size);
    let offset = 0;
    for (const part of this.parts) {
      out.set(part, offset);
      offset += part.length;
    }
    return out;
  }
}

const utf8 = new TextDecoder();

/** Rebuilds a message, rewriting the length-delimited fields `rewrite` handles. */
function rewriteMessage(buf: Uint8Array, rewrite: (field: Field) => Uint8Array | undefined): Uint8Array {
  const out = new Writer();
  for (const field of fields(buf)) {
    const replaced = field.wire === LEN ? rewrite(field) : undefined;
    if (replaced) out.bytesField(field.num, replaced);
    else out.raw(field.raw);
  }
  return out.finish();
}

/** IEEE half-precision values to single precision. */
function halfToFloat(halves: ArrayLike<number>): Uint8Array {
  const out = new Uint32Array(halves.length);
  for (let i = 0; i < halves.length; i++) {
    const h = halves[i];
    const sign = (h & 0x8000) << 16;
    const exponent = (h >> 10) & 0x1f;
    let mantissa = h & 0x3ff;
    if (exponent === 0) {
      if (mantissa === 0) {
        out[i] = sign;
      } else {
        // Subnormal: normalise the mantissa.
        let shift = -1;
        do {
          shift++;
          mantissa <<= 1;
        } while (!(mantissa & 0x400));
        out[i] = sign | ((112 - shift) << 23) | ((mantissa & 0x3ff) << 13);
      }
    } else if (exponent === 31) {
      out[i] = sign | 0x7f800000 | (mantissa << 13);
    } else {
      out[i] = sign | ((exponent + 112) << 23) | (mantissa << 13);
    }
  }
  return new Uint8Array(out.buffer);
}

function packedVarints(bytes: Uint8Array): number[] {
  const values: number[] = [];
  let pos = 0;
  while (pos < bytes.length) {
    let value: number;
    [value, pos] = readVarint(bytes, pos);
    values.push(value);
  }
  return values;
}

class Converter {
  converted = 0;

  // TensorProto: dims 1, data_type 2, int32_data 5, raw_data 9, external_data 13.
  tensor(buf: Uint8Array): Uint8Array | undefined {
    let dataType = 0;
    let raw: Uint8Array | null = null;
    const int32: number[] = [];
    for (const f of fields(buf)) {
      if (f.num === 2 && f.wire === VARINT) dataType = f.int;
      else if (f.num === 9 && f.wire === LEN) raw = f.bytes;
      else if (f.num === 5) int32.push(...(f.wire === LEN ? packedVarints(f.bytes) : [f.int]));
      else if (f.num === 13) throw new Error("networks with external data are not supported");
    }
    if (dataType !== FLOAT16) return undefined;
    // raw_data is little-endian; copy it so the view is aligned.
    const halves = raw ? new Uint16Array(raw.slice().buffer) : int32;
    const out = new Writer();
    for (const f of fields(buf)) {
      if (f.num === 2 || f.num === 5 || f.num === 9) continue;
      out.raw(f.raw);
    }
    out.varintField(2, FLOAT);
    out.bytesField(9, halfToFloat(halves));
    this.converted++;
    return out.finish();
  }

  // ValueInfoProto.type 2.
  valueInfo(buf: Uint8Array): Uint8Array | undefined {
    return this.changed(buf, (f) => (f.num === 2 ? this.type(f.bytes) : undefined));
  }

  // TypeProto.tensor_type 1.
  type(buf: Uint8Array): Uint8Array | undefined {
    return this.changed(buf, (f) => (f.num === 1 ? this.tensorType(f.bytes) : undefined));
  }

  // TypeProto.Tensor.elem_type 1.
  tensorType(buf: Uint8Array): Uint8Array | undefined {
    const out = new Writer();
    let changed = false;
    for (const f of fields(buf)) {
      if (f.num === 1 && f.wire === VARINT && f.int === FLOAT16) {
        out.varintField(1, FLOAT);
        changed = true;
      } else out.raw(f.raw);
    }
    if (!changed) return undefined;
    this.converted++;
    return out.finish();
  }

  // AttributeProto: name 1, i 3, t 5, g 6, tensors 10, graphs 11.
  attribute(buf: Uint8Array): Uint8Array | undefined {
    let name = "";
    for (const f of fields(buf)) if (f.num === 1 && f.wire === LEN) name = utf8.decode(f.bytes);
    const out = new Writer();
    let changed = false;
    for (const f of fields(buf)) {
      // Retarget explicit Cast-to-FP16 nodes.
      if (name === "to" && f.num === 3 && f.wire === VARINT && f.int === FLOAT16) {
        out.varintField(3, FLOAT);
        this.converted++;
        changed = true;
        continue;
      }
      let replaced: Uint8Array | undefined;
      if (f.wire === LEN && (f.num === 5 || f.num === 10)) replaced = this.tensor(f.bytes);
      else if (f.wire === LEN && (f.num === 6 || f.num === 11)) replaced = this.graph(f.bytes);
      if (replaced) {
        out.bytesField(f.num, replaced);
        changed = true;
      } else out.raw(f.raw);
    }
    return changed ? out.finish() : undefined;
  }

  // NodeProto.attribute 5.
  node(buf: Uint8Array): Uint8Array | undefined {
    return this.changed(buf, (f) => (f.num === 5 ? this.attribute(f.bytes) : undefined));
  }

  // GraphProto: node 1, initializer 5, input 11, output 12, value_info 13.
  graph(buf: Uint8Array): Uint8Array | undefined {
    return this.changed(buf, (f) => {
      if (f.num === 1) return this.node(f.bytes);
      if (f.num === 5) return this.tensor(f.bytes);
      if (f.num === 11 || f.num === 12 || f.num === 13) return this.valueInfo(f.bytes);
      return undefined;
    });
  }

  private changed(buf: Uint8Array, rewrite: (field: Field) => Uint8Array | undefined): Uint8Array | undefined {
    let changed = false;
    const out = rewriteMessage(buf, (f) => {
      const replaced = rewrite(f);
      if (replaced) changed = true;
      return replaced;
    });
    return changed ? out : undefined;
  }
}

function tensorInfo(buf: Uint8Array): NetworkTensorInfo {
  const info: NetworkTensorInfo = { name: "", elemType: 0, dims: [] };
  for (const f of fields(buf)) {
    if (f.num === 1 && f.wire === LEN) info.name = utf8.decode(f.bytes);
    if (f.num !== 2 || f.wire !== LEN) continue;
    for (const t of fields(f.bytes)) {
      if (t.num !== 1 || t.wire !== LEN) continue;
      for (const e of fields(t.bytes)) {
        if (e.num === 1 && e.wire === VARINT) info.elemType = e.int;
        if (e.num !== 2 || e.wire !== LEN) continue;
        for (const dim of fields(e.bytes)) {
          if (dim.num !== 1 || dim.wire !== LEN) continue;
          let size: number | null = null;
          for (const d of fields(dim.bytes)) if (d.num === 1 && d.wire === VARINT) size = d.int;
          info.dims.push(size);
        }
      }
    }
  }
  return info;
}

/** Converts an FP16 network to FP32; FP32 networks come back unchanged. */
export function convertToFp32(model: Uint8Array): ConvertedNetwork {
  const converter = new Converter();
  let graph: Uint8Array | null = null;
  // ModelProto.graph 7.
  const converted = rewriteMessage(model, (f) => {
    if (f.num !== 7) return undefined;
    const replaced = converter.graph(f.bytes);
    graph = replaced ?? f.bytes;
    return replaced;
  });
  if (!graph) throw new Error("not an ONNX model: no graph");
  const inputs: NetworkTensorInfo[] = [];
  const outputs: NetworkTensorInfo[] = [];
  for (const f of fields(graph)) {
    if (f.num === 11 && f.wire === LEN) inputs.push(tensorInfo(f.bytes));
    if (f.num === 12 && f.wire === LEN) outputs.push(tensorInfo(f.bytes));
  }
  return { model: converter.converted ? converted : model, inputs, outputs, converted: converter.converted };
}

/** A node's inputs, outputs, name, type and attributes (by name). */
interface NodeFields {
  inputs: string[];
  outputs: string[];
  name: string;
  opType: string;
  domain: string;
  attributes: Map<string, Uint8Array>;
}

// NodeProto: input 1, output 2, name 3, op_type 4, attribute 5, domain 7.
function readNode(buf: Uint8Array): NodeFields {
  const node: NodeFields = { inputs: [], outputs: [], name: "", opType: "", domain: "", attributes: new Map() };
  for (const f of fields(buf)) {
    if (f.wire !== LEN) continue;
    if (f.num === 1) node.inputs.push(utf8.decode(f.bytes));
    else if (f.num === 2) node.outputs.push(utf8.decode(f.bytes));
    else if (f.num === 3) node.name = utf8.decode(f.bytes);
    else if (f.num === 4) node.opType = utf8.decode(f.bytes);
    else if (f.num === 7) node.domain = utf8.decode(f.bytes);
    else if (f.num === 5) {
      for (const a of fields(f.bytes)) if (a.num === 1 && a.wire === LEN) node.attributes.set(utf8.decode(a.bytes), f.bytes);
    }
  }
  return node;
}

/** An integer attribute (AttributeProto.i 3), if it is small and not negative. */
function intAttribute(node: NodeFields, name: string): number | undefined {
  const attribute = node.attributes.get(name);
  if (!attribute) return undefined;
  for (const f of fields(attribute)) if (f.num === 3 && f.wire === VARINT && f.int < 2 ** 31) return f.int;
  return undefined;
}

/** The values of an INT64 tensor (TensorProto: data_type 2, int64_data 7, name 8, raw_data 9). */
function int64Tensor(buf: Uint8Array): { name: string; values: number[] } | undefined {
  let dataType = 0;
  let name = "";
  let raw: Uint8Array | null = null;
  const values: number[] = [];
  for (const f of fields(buf)) {
    if (f.num === 2 && f.wire === VARINT) dataType = f.int;
    else if (f.num === 8 && f.wire === LEN) name = utf8.decode(f.bytes);
    else if (f.num === 7) values.push(...(f.wire === LEN ? packedVarints(f.bytes) : [f.int]));
    else if (f.num === 9 && f.wire === LEN) raw = f.bytes;
  }
  if (dataType !== INT64) return undefined;
  // raw_data is little-endian; copy it so the view is aligned.
  if (raw) values.push(...Array.from(new BigInt64Array(raw.slice().buffer), Number));
  return { name, values };
}

const utf8Encoder = new TextEncoder();

function int64Initializer(name: string, values: number[]): Uint8Array {
  const out = new Writer();
  out.varintField(1, values.length);
  out.varintField(2, INT64);
  out.bytesField(8, utf8Encoder.encode(name));
  out.bytesField(9, new Uint8Array(BigInt64Array.from(values, BigInt).buffer));
  return out.finish();
}

function sliceNode(name: string, inputs: string[], output: string): Uint8Array {
  const out = new Writer();
  for (const input of inputs) out.bytesField(1, utf8Encoder.encode(input));
  out.bytesField(2, utf8Encoder.encode(output));
  out.bytesField(3, utf8Encoder.encode(name));
  out.bytesField(4, utf8Encoder.encode("Slice"));
  return out.finish();
}

/**
 * Replaces each Split whose sizes are a constant input (opset 13+) with one
 * Slice per output. Splits it cannot read are left alone.
 */
export function splitsToSlices(model: Uint8Array): { model: Uint8Array; replaced: number } {
  let replaced = 0;
  // ModelProto.graph 7; GraphProto: node 1, initializer 5.
  const rewritten = rewriteMessage(model, (f) => {
    if (f.num !== 7) return undefined;
    const ints = new Map<string, number[]>();
    for (const g of fields(f.bytes)) {
      if (g.num !== 5 || g.wire !== LEN) continue;
      const tensor = int64Tensor(g.bytes);
      if (tensor) ints.set(tensor.name, tensor.values);
    }
    const graph = new Writer();
    const initializers: Uint8Array[] = [];
    for (const g of fields(f.bytes)) {
      if (g.num === 1 && g.wire === LEN) {
        const node = readNode(g.bytes);
        const axis = node.opType === "Split" && !node.domain ? intAttribute(node, "axis") ?? 0 : undefined;
        const sizes = node.inputs[1] ? ints.get(node.inputs[1]) : undefined;
        if (axis !== undefined && sizes?.length === node.outputs.length && sizes.every((n) => n >= 0)) {
          const prefix = `${node.name || node.outputs[0]}/as_slice`;
          initializers.push(int64Initializer(`${prefix}/axes`, [axis]));
          let start = 0;
          node.outputs.forEach((output, i) => {
            const bounds = [`${prefix}/starts_${i}`, `${prefix}/ends_${i}`];
            initializers.push(int64Initializer(bounds[0], [start]), int64Initializer(bounds[1], [start + sizes[i]]));
            start += sizes[i];
            // An empty output name means the output is unused.
            if (output) graph.bytesField(1, sliceNode(`${prefix}_${i}`, [node.inputs[0], ...bounds, `${prefix}/axes`], output));
          });
          replaced++;
          continue;
        }
      }
      graph.raw(g.raw);
    }
    for (const initializer of initializers) graph.bytesField(5, initializer);
    return replaced ? graph.finish() : undefined;
  });
  return { model: replaced ? rewritten : model, replaced };
}
