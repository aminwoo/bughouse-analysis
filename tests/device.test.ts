import { afterEach, describe, expect, it, vi } from "vitest";
import { automaticCpuWorkers, isLowMemoryDevice, liveAnalysisNodes } from "../src/lib/device";

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const PIXEL = "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36";
const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
const LINUX = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

function device(userAgent: string, extra: Record<string, unknown> = {}) {
  vi.stubGlobal("navigator", { userAgent, maxTouchPoints: 0, ...extra });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("isLowMemoryDevice", () => {
  it("picks out phones and tablets", () => {
    device(IPHONE, { maxTouchPoints: 5 });
    expect(isLowMemoryDevice()).toBe(true);
    device(PIXEL, { maxTouchPoints: 5 });
    expect(isLowMemoryDevice()).toBe(true);
    // iPadOS reports a Mac with a touch screen.
    device(MAC, { maxTouchPoints: 5 });
    expect(isLowMemoryDevice()).toBe(true);
  });

  it("leaves desktops on the full engine unless they report little memory", () => {
    device(MAC);
    expect(isLowMemoryDevice()).toBe(false);
    device(LINUX, { deviceMemory: 8 });
    expect(isLowMemoryDevice()).toBe(false);
    device(LINUX, { deviceMemory: 4 });
    expect(isLowMemoryDevice()).toBe(true);
    device(LINUX, { userAgentData: { mobile: true } });
    expect(isLowMemoryDevice()).toBe(true);
  });
});

describe("engine size", () => {
  it("keeps phones to two CPU workers and a smaller tree", () => {
    expect(automaticCpuWorkers(8, true)).toBe(2);
    expect(automaticCpuWorkers(1, true)).toBe(1);
    expect(automaticCpuWorkers(8, false)).toBe(7);
    expect(automaticCpuWorkers(32, false)).toBe(16);
    expect(liveAnalysisNodes(true)).toBeLessThan(liveAnalysisNodes(false));
  });
});
