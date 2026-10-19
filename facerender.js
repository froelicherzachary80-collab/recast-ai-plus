// RECAST AI+ — WebGL2 mesh-warp face renderer.
// Draws the source frame as background, then each replacement face as a textured triangle mesh whose
// vertices follow the tracked source landmarks (expression & head pose), with per-vertex feather alpha
// and per-vertex low-frequency color/lighting gains (SceneBlend).

const VS_BG = `#version 300 es
in vec2 aPos; out vec2 vUv;
void main(){ vUv = vec2(aPos.x*0.5+0.5, 0.5-aPos.y*0.5); gl_Position = vec4(aPos,0.,1.); }`;
const FS_BG = `#version 300 es
precision mediump float; in vec2 vUv; uniform sampler2D uTex; out vec4 o;
void main(){ o = texture(uTex, vUv); }`;
const VS_FACE = `#version 300 es
in vec2 aPos; in vec2 aUv; in float aAlpha; in vec3 aGain;
uniform vec2 uRes; out vec2 vUv; out float vA; out vec3 vG;
void main(){ vUv=aUv; vA=aAlpha; vG=aGain; vec2 p = aPos/uRes*2.-1.; gl_Position = vec4(p.x,-p.y,0.,1.); }`;
const FS_FACE = `#version 300 es
precision highp float; in vec2 vUv; in float vA; in vec3 vG;
uniform sampler2D uTex; uniform float uOpacity; uniform float uGrain; uniform float uSeed; uniform float uSat; uniform float uBias;
out vec4 o;
float hash(vec2 p){ p = fract(p*vec2(123.34,456.21)); p += dot(p,p+45.32+uSeed); return fract(p.x*p.y); }
void main(){
  vec4 t = texture(uTex, vUv, uBias); vec3 c = t.rgb * vG;
  float l = dot(c, vec3(0.299,0.587,0.114)); c = mix(vec3(l), c, uSat);
  c += (hash(gl_FragCoord.xy) - 0.5) * uGrain;
  o = vec4(clamp(c,0.,1.), vA*uOpacity*t.a);
}`;
const VS_MASK = VS_FACE;
const FS_MASK = `#version 300 es
precision mediump float; in vec2 vUv; in float vA; in vec3 vG; uniform float uOpacity; out vec4 o;
void main(){ o = vec4(0.62,0.42,1.0, vA*uOpacity); }`;

function compile(gl, vs, fs) {
  const p = gl.createProgram();
  for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
    const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('Shader: ' + gl.getShaderInfoLog(s));
    gl.attachShader(p, s);
  }
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('Link: ' + gl.getProgramInfoLog(p));
  return p;
}

export class FaceRenderer {
  constructor(width, height) {
    this.canvas = document.createElement('canvas'); this.canvas.width = width; this.canvas.height = height;
    const gl = this.canvas.getContext('webgl2', { premultipliedAlpha: false, preserveDrawingBuffer: true, antialias: true });
    if (!gl) throw new Error('WebGL2 is not available: face replacement cannot run in this browser.');
    this.gl = gl;
    this.pBg = compile(gl, VS_BG, FS_BG); this.pFace = compile(gl, VS_FACE, FS_FACE); this.pMask = compile(gl, VS_MASK, FS_MASK);
    this.quad = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    this.bufs = { pos: gl.createBuffer(), uv: gl.createBuffer(), a: gl.createBuffer(), g: gl.createBuffer(), idx: gl.createBuffer() };
    this.bgTex = this._tex(); this.texCache = new Map();
    this.vao = gl.createVertexArray();
  }
  _tex() {
    const gl = this.gl, t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }
  /** Upload a reference image once; cached by key. */
  texture(key, image) {
    if (this.texCache.has(key)) return this.texCache.get(key);
    const gl = this.gl, t = this._tex();
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
    // mipmaps: correct minification of high-res reference photos onto small on-screen faces (less shimmer/oversharpening)
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    this.texCache.set(key, t);
    return t;
  }
  resize(w, h) { if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; } }
  _attr(prog, name, buf, size) {
    const gl = this.gl, loc = gl.getAttribLocation(prog, name); if (loc < 0) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
  }
  /** frame: canvas/image source; draws: [{tex, pos, uv, alpha, gain, idx, opacity, grain, sat}]; maskOnly: draw alpha as violet overlay. */
  render(frame, draws, { maskOnly = false } = {}) {
    const gl = this.gl, W = this.canvas.width, H = this.canvas.height;
    gl.viewport(0, 0, W, H); gl.bindVertexArray(this.vao);
    gl.disable(gl.BLEND);
    gl.useProgram(this.pBg);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.bgTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame);
    gl.uniform1i(gl.getUniformLocation(this.pBg, 'uTex'), 0);
    this._attr(this.pBg, 'aPos', this.quad, 2);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    if (!draws.length) return this.canvas;
    gl.enable(gl.BLEND); gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    const prog = maskOnly ? this.pMask : this.pFace;
    gl.useProgram(prog);
    gl.uniform2f(gl.getUniformLocation(prog, 'uRes'), W, H);
    for (const d of draws) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.bufs.pos); gl.bufferData(gl.ARRAY_BUFFER, d.pos, gl.DYNAMIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.bufs.uv); gl.bufferData(gl.ARRAY_BUFFER, d.uv, gl.DYNAMIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.bufs.a); gl.bufferData(gl.ARRAY_BUFFER, d.alpha, gl.DYNAMIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.bufs.g); gl.bufferData(gl.ARRAY_BUFFER, d.gain, gl.DYNAMIC_DRAW);
      this._attr(prog, 'aPos', this.bufs.pos, 2); this._attr(prog, 'aUv', this.bufs.uv, 2);
      this._attr(prog, 'aAlpha', this.bufs.a, 1); this._attr(prog, 'aGain', this.bufs.g, 3);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.bufs.idx); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, d.idx, gl.DYNAMIC_DRAW);
      if (!maskOnly) {
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, d.tex);
        gl.uniform1i(gl.getUniformLocation(prog, 'uTex'), 0);
        gl.uniform1f(gl.getUniformLocation(prog, 'uGrain'), d.grain || 0);
        gl.uniform1f(gl.getUniformLocation(prog, 'uSeed'), Math.random() * 100);
        gl.uniform1f(gl.getUniformLocation(prog, 'uSat'), d.sat ?? 1);
        gl.uniform1f(gl.getUniformLocation(prog, 'uBias'), d.bias ?? 0);
      }
      gl.uniform1f(gl.getUniformLocation(prog, 'uOpacity'), maskOnly ? 0.75 : (d.opacity ?? 1));
      gl.drawElements(gl.TRIANGLES, d.idx.length, gl.UNSIGNED_SHORT, 0);
    }
    return this.canvas;
  }
  dispose() {
    const gl = this.gl; for (const t of this.texCache.values()) gl.deleteTexture(t); this.texCache.clear();
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
