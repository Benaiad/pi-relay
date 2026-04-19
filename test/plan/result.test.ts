import { describe, expect, it } from "vitest";
import {
  err,
  flatMapResult,
  isErr,
  isOk,
  mapResult,
  ok,
  type Result,
} from "../../src/plan/result.js";

describe("Result", () => {
  it("constructs ok and err shapes", () => {
    const good: Result<number, string> = ok(42);
    const bad: Result<number, string> = err("broken");
    expect(good).toEqual({ ok: true, value: 42 });
    expect(bad).toEqual({ ok: false, error: "broken" });
  });

  it("narrows via isOk and isErr", () => {
    const good: Result<number, string> = ok(1);
    if (isOk(good)) {
      const _: number = good.value;
      void _;
    } else {
      throw new Error("unreachable");
    }

    const bad: Result<number, string> = err("no");
    if (isErr(bad)) {
      const _: string = bad.error;
      void _;
    } else {
      throw new Error("unreachable");
    }
  });

  it("mapResult transforms the ok branch and passes errors through", () => {
    const doubled = mapResult<number, number, string>(ok(3), (n) => n * 2);
    const passthrough = mapResult<number, number, string>(
      err("nope"),
      (n) => n * 2,
    );
    expect(doubled).toEqual(ok(6));
    expect(passthrough).toEqual(err("nope"));
  });

  it("flatMapResult chains fallible operations", () => {
    const half = (n: number): Result<number, string> =>
      n % 2 === 0 ? ok(n / 2) : err("odd");
    expect(flatMapResult(ok<number>(10), half)).toEqual(ok(5));
    expect(flatMapResult(ok<number>(7), half)).toEqual(err("odd"));
    expect(flatMapResult(err<string>("prior"), half)).toEqual(err("prior"));
  });
});
