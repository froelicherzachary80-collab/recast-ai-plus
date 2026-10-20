/** Tiny ONNX protobuf writer used ONLY by tests to build synthetic graphs with real RVC/MDX I/O signatures. */
class W {
  b: number[] = [];
  varint(v: number | bigint) { let x = BigInt(v); if (x < 0n) x += 1n << 64n; while (x >= 0x80n) { this.b.push(Number(x & 0x7fn) | 0x80); x >>= 7n; } this.b.push(Number(x)); return this; }
  tag(f: number, wt: number) { return this.varint((f << 3) | wt); }
  int(f: number, v: number | bigint) { return this.tag(f, 0).varint(v); }
  bytes(f: number, d: Uint8Array | number[]) { this.tag(f, 2).varint(d.length); for (let i = 0; i < d.length; i++) this.b.push(d[i]); return this; }
  str(f: number, s: string) { return this.bytes(f, Array.from(new TextEncoder().encode(s))); }
  msg(f: number, m: W) { return this.bytes(f, m.b); }
  u8() { return new Uint8Array(this.b); }
}
export type Dim = number | string;
export const FLOAT = 1, INT64 = 7;
function valueInfo(name: string, elem: number, dims: Dim[]) {
  const shape = new W(); for (const d of dims) { const dm = new W(); typeof d === 'number' ? dm.int(1, d) : dm.str(2, d); shape.msg(1, dm); }
  const tt = new W().int(1, elem).msg(2, shape);
  return new W().str(1, name).msg(2, new W().msg(1, tt));
}
export interface NodeDef { op: string; inputs: string[]; outputs: string[]; attrs?: { name: string; ints?: number[]; i?: number; f?: number }[]; }
export interface InitDef { name: string; dims: number[]; float?: Float32Array; int64?: number[]; }
export function buildModel(inputs: [string, number, Dim[]][], outputs: [string, number, Dim[]][], nodes: NodeDef[], inits: InitDef[] = []): Uint8Array {
  const g = new W();
  nodes.forEach((n, i) => {
    const nd = new W(); n.inputs.forEach((s) => nd.str(1, s)); n.outputs.forEach((s) => nd.str(2, s)); nd.str(3, `n${i}`).str(4, n.op);
    for (const a of n.attrs ?? []) {
      const at = new W().str(1, a.name);
      if (a.ints) { at.int(20, 7); for (const v of a.ints) at.int(8, v); }
      else if (a.f !== undefined) { at.int(20, 1); const fb = new Uint8Array(new Float32Array([a.f]).buffer); at.tag(2, 5); at.b.push(...fb); }
      else { at.int(20, 2).int(3, a.i ?? 0); }
      nd.msg(5, at);
    }
    g.msg(1, nd);
  });
  g.str(2, 'g');
  for (const it of inits) {
    const t = new W(); it.dims.forEach((d) => t.int(1, d));
    if (it.float) { t.int(2, FLOAT).str(8, it.name).bytes(9, new Uint8Array(it.float.buffer)); }
    else { t.int(2, INT64).str(8, it.name).bytes(9, Array.from(new Uint8Array(BigInt64Array.from(it.int64!.map(BigInt)).buffer))); }
    g.msg(5, t);
  }
  inputs.forEach(([n, e, d]) => g.msg(11, valueInfo(n, e, d)));
  outputs.forEach(([n, e, d]) => g.msg(12, valueInfo(n, e, d)));
  const m = new W().int(1, 8).msg(8, new W().str(1, '').int(2, 17)).str(2, 'zvox-test').msg(7, g);
  return m.u8();
}
