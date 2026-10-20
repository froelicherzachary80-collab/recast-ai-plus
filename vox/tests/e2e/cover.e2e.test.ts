/**
 * End-to-end browser test (headless Chromium via playwright-core) against the production build.
 * Covers acceptance items: WAV+MP3 import, waveform/analysis, playback, DSP separation, model import,
 * ONNX Runtime Web inference in the worker (synthetic RVC-signature graph), mix, effects, WAV/MP3
 * export, save/reopen, offline reload from the service worker, and absence of upload requests.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type Page, type BrowserContext } from 'playwright-core';
import { preview } from 'vite';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { syntheticSong, wavBytes, fakeContentOnnx, fakeRvcOnnx, fakeMdxOnnx } from '../fixtures';
import { decodeWav } from '../../src/audio/wav';
import { yinF0, hzToMidi } from '../../src/audio/f0';
import { resample } from '../../src/audio/resample';

const DIR = 'tests/.tmp/e2e';
let server: any, browser: Browser, ctx: BrowserContext, page: Page, base: string;
const errors: string[] = [];

beforeAll(async () => {
  mkdirSync(DIR, { recursive: true });
  const song = syntheticSong();
  writeFileSync(`${DIR}/song.wav`, wavBytes(song.mix));
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', `${DIR}/song.wav`, '-b:a', '192k', `${DIR}/song.mp3`]);
  writeFileSync(`${DIR}/content-test.onnx`, fakeContentOnnx());
  writeFileSync(`${DIR}/voice-test.onnx`, fakeRvcOnnx());
  writeFileSync(`${DIR}/mdx-test.onnx`, fakeMdxOnnx());
  server = await preview({ preview: { port: 4179, strictPort: true }, logLevel: 'silent' });
  base = 'http://localhost:4179/';
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--autoplay-policy=no-user-gesture-required', '--enable-unsafe-webgpu'] });
  ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 393, height: 852 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(base);
});
afterAll(async () => { await browser?.close(); await new Promise((r) => server?.httpServer?.close(r)); });

const nav = async (label: string) => { await page.click('button[aria-label=Menu]'); await page.locator('nav button', { hasText: label }).click(); };
const waitJob = async (timeout = 240000) => {
  await page.waitForFunction(() => !document.querySelector('.jobbar') || !!document.querySelector('.jobbar.err, .jobbar.done'), null, { timeout })
    .catch(async (e) => { throw new Error(`${e.message}\njobbar: ${await page.locator('.jobbar').textContent().catch(() => '')}`); });
  if (await page.locator('.jobbar.err').count()) throw new Error(`Job failed: ${await page.locator('.jobbar').textContent()}`);
  if (await page.locator('.jobbar button', { hasText: 'Close' }).count()) await page.locator('.jobbar button', { hasText: 'Close' }).click();
};
const upload = async (buttonText: string | RegExp, file: string, scope?: string) => {
  const [fc] = await Promise.all([page.waitForEvent('filechooser'), (scope ? page.locator(scope) : page).locator('button, label.btn', { hasText: buttonText }).first().click()]);
  await fc.setFiles(file);
};
const download = async (click: () => Promise<void>, path: string) => { const [d] = await Promise.all([page.waitForEvent('download', { timeout: 240000 }), click()]); await d.saveAs(path); return path; };

describe('ZMF VOX STUDIO+ end-to-end (Chromium)', () => {
  it('imports an MP3 and shows real analysis', async () => {
    // headless Chromium's WebGPU is a software emulator; exercise the WASM execution provider
    await nav('Settings'); await page.locator('.seg button', { hasText: 'WASM only' }).click();
    await nav('AI Cover Studio');
    await upload('Upload MP3', `${DIR}/song.mp3`);
    await waitJob();
    await expect.poll(async () => page.locator('.stat span', { hasText: 'Length' }).count()).toBe(1);
    const stats = await page.locator('.stat').allTextContents();
    expect(stats.some((s) => /0:1[12]\.\d/.test(s))).toBe(true);
    expect(stats.some((s) => /Channels/.test(s) && /^2/.test(s))).toBe(true);
  });
  it('imports a WAV (replacing the song) and plays it', async () => {
    await upload('Replace song', `${DIR}/song.wav`);
    await waitJob();
    expect((await page.locator('.stat').allTextContents()).some((s) => s.startsWith('44100 Hz'))).toBe(true);
    await page.locator('button', { hasText: '▶ Play' }).first().click();
    await page.waitForTimeout(600);
    expect(await page.locator('button', { hasText: '■ Stop' }).count()).toBeGreaterThan(0);
    await page.locator('button', { hasText: '■ Stop' }).first().click();
  });
  it('separates (DSP fallback) into different stems', async () => {
    await page.locator('.seg button', { hasText: 'DSP centre' }).click();
    await page.locator('label', { hasText: 'Preview first' }).locator('input').uncheck();
    await page.locator('button', { hasText: /^Separate$/ }).click();
    await waitJob();
    await expect.poll(async () => (await page.locator('.pill', { hasText: 'stems differ' }).count())).toBe(1);
  });
  it('imports ONNX models and creates a neural singer', async () => {
    await nav('Model Manager');
    await page.locator('label', { hasText: 'I own this model' }).locator('input').check();
    await upload('Import .onnx', `${DIR}/content-test.onnx`); await waitJob();
    await upload('Import .onnx', `${DIR}/voice-test.onnx`); await waitJob();
    await expect.poll(async () => page.locator('.item .pill', { hasText: 'RVC voice model' }).count()).toBe(1);
    expect(await page.locator('.item .pill', { hasText: 'Content encoder' }).count()).toBe(1);
    await nav('My AI Singers');
    await page.locator('button', { hasText: 'New singer' }).click();
    await page.locator('label', { hasText: 'Name' }).locator('input').fill('Test Oscillator Voice');
    await page.locator('label', { hasText: 'RVC voice model' }).locator('select').selectOption({ index: 1 });
    await page.locator('label', { hasText: 'Content encoder' }).locator('select').selectOption({ index: 1 });
    await page.locator('textarea').nth(1).fill('Synthetic test model created by the e2e test.');
    await page.locator('label', { hasText: 'I confirm this voice' }).locator('input').check();
    await page.locator('button', { hasText: 'Save singer' }).click();
    await page.locator('.item', { hasText: 'Test Oscillator Voice' }).locator('button', { hasText: 'Use' }).click();
  });
  it('runs MDX-signature separation through ORT Web and flags identical stems honestly', async () => {
    await nav('Model Manager');
    await page.locator('label', { hasText: 'I own this model' }).locator('input').check();
    await upload('Import .onnx', `${DIR}/mdx-test.onnx`); await waitJob();
    await expect.poll(async () => page.locator('.item .pill', { hasText: 'MDX-Net separation' }).count()).toBe(1);
    await nav('AI Cover Studio');
    await page.locator('.seg button', { hasText: 'Neural (MDX-Net)' }).click();
    await page.locator('label', { hasText: 'Preview first' }).locator('input').check();
    await page.locator('button', { hasText: /^Separate$/ }).click();
    await waitJob();
    // the 0.5× test graph yields identical halves: the UI must report that rather than claim success
    await expect.poll(async () => page.locator('.pill', { hasText: 'nearly identical' }).count()).toBe(1);
    await page.locator('.seg button', { hasText: 'DSP centre' }).click();
    await page.locator('label', { hasText: 'Preview first' }).locator('input').uncheck();
    await page.locator('button', { hasText: /^Separate$/ }).click();
    await waitJob();
  });
  it('runs neural conversion through ONNX Runtime Web and the melody is preserved', async () => {
    await nav('AI Cover Studio');
    await page.locator('.seg button', { hasText: 'LIGHT' }).click();
    await page.locator('button', { hasText: /^Convert full vocal$/ }).click();
    await waitJob();
    const ev = await page.locator('.stat').allTextContents();
    console.log('[evidence]', ev.join(' | '));
    expect(ev.some((s) => s.startsWith('Neural'))).toBe(true);
    expect(ev.some((s) => s.startsWith('wasm'))).toBe(true);
    const melody = ev.find((s) => s.includes('Median melody error'))!;
    expect(parseFloat(melody)).toBeLessThan(40);
    const diff = parseFloat(ev.find((s) => s.includes('NRMS waveform difference'))!);
    expect(diff).toBeGreaterThan(0.3);
  });
  it('renders the cover mix and exports dry vocal WAV + MP3', async () => {
    await page.locator('button', { hasText: 'Render cover mix' }).click();
    await waitJob();
    await nav('Export Studio');
    await page.locator('.seg button', { hasText: 'WAV 16-bit' }).click();
    const dry = page.locator('.item', { hasText: 'converted-dry' }).first();
    const wavPath = await download(() => dry.locator('button', { hasText: 'Export' }).click(), `${DIR}/dry.wav`);
    await waitJob();
    const pcm = decodeWav(readFileSync(wavPath).buffer as ArrayBuffer);
    expect(pcm.sampleRate).toBe(44100);
    // the test "voice" is an oscillator following the target F0 => output pitch must match the source melody
    const src = syntheticSong().vocal, tr = yinF0(resample(pcm.channels[0], 44100, 16000), 16000), ts = yinF0(resample(src, 44100, 16000), 16000);
    const err: number[] = []; for (let i = 0; i < Math.min(tr.f0.length, ts.f0.length); i++) if (tr.voiced[i] && ts.voiced[i]) err.push(Math.abs(hzToMidi(tr.f0[i]) - hzToMidi(ts.f0[i])) * 100);
    err.sort((a, b) => a - b); expect(err[err.length >> 1]).toBeLessThan(30);
    await page.locator('.seg button', { hasText: 'MP3' }).click();
    const mp3 = await download(() => page.locator('button', { hasText: 'Mastered mix' }).click(), `${DIR}/mix.mp3`);
    await waitJob();
    const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,channels:format=duration', '-of', 'json', mp3]).toString());
    expect(probe.streams[0].codec_name).toBe('mp3'); expect(parseFloat(probe.format.duration)).toBeGreaterThan(11);
  });
  it('bounces the full mix through the mixer DSP chain', async () => {
    await nav('Audio Mixer');
    await page.locator('button', { hasText: 'Bounce full mix' }).click(); await waitJob();
    expect(await page.locator('.strip').count()).toBeGreaterThanOrEqual(3);
  });
  it('saves, reloads (project reopens) and works offline from the service worker', async () => {
    await page.waitForTimeout(1500);
    await page.reload(); await page.waitForTimeout(1500);
    await nav('Project Library');
    await expect.poll(async () => page.locator('.item .pill', { hasText: 'open' }).count()).toBe(1);
    await page.waitForFunction(() => navigator.serviceWorker?.controller != null, null, { timeout: 30000 }).catch(async () => { await page.reload(); await page.waitForFunction(() => navigator.serviceWorker?.controller != null, null, { timeout: 30000 }); });
    await ctx.setOffline(true);
    await page.reload();
    await page.waitForSelector('nav button', { timeout: 20000 });
    await nav('AI Cover Studio');
    await expect.poll(async () => page.locator('.stat span', { hasText: 'Length' }).count(), { timeout: 20000 }).toBe(1);
    await ctx.setOffline(false);
  });
  it('made no upload requests and no uncaught errors', async () => {
    await nav('Settings');
    const txt = await page.locator('.card', { hasText: 'Privacy' }).textContent();
    expect(txt).toMatch(/0 with a request body/);
    expect(errors.filter((e) => !/favicon|WebGPU|webgpu|adapter|onnxruntime.*\[W:|LogEarlyWarning/i.test(e))).toEqual([]);
  });
});
