#!/usr/bin/env node
/*
  Genera los clips de audio de asistente-pliegues.html con Azure Speech (voces es-CR).
  Lee la lista de clips directamente de la página, así que siempre coinciden.

  Uso (Node 18 o más nuevo, sin instalar nada):

    Mac / Linux:
      export AZURE_SPEECH_KEY="tu-clave"
      export AZURE_SPEECH_REGION="eastus"        # la región de tu recurso de Speech
      node generar-clips.js

    Windows (PowerShell):
      $env:AZURE_SPEECH_KEY="tu-clave"
      $env:AZURE_SPEECH_REGION="eastus"
      node generar-clips.js

  Opciones:
    --voz es-CR-JuanNeural   cambia la voz (por defecto es-CR-MariaNeural)
    --force                  vuelve a generar aunque el clip ya exista

  Variable opcional AZURE_RATE (por ejemplo "-10%") para hablar más lento.
  Si tienes ffmpeg instalado, el script recorta el silencio al inicio y al final de cada clip,
  para que los dígitos suenen seguidos y no entrecortados.
*/
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const args = process.argv.slice(2);
const force = args.includes('--force');
const vi = args.indexOf('--voz');
const VOICE = (vi >= 0 && args[vi + 1]) || process.env.AZURE_VOICE || 'es-CR-MariaNeural';
const RATE = process.env.AZURE_RATE || '';
const KEY = process.env.AZURE_SPEECH_KEY;
const REGION = process.env.AZURE_SPEECH_REGION;
const ENDPOINT = process.env.AZURE_TTS_ENDPOINT ||
  (REGION ? `https://${REGION}.tts.speech.microsoft.com/cognitiveservices/v1` : '');
const htmlPath = path.resolve(process.env.PAGINA || path.join(__dirname, 'asistente-pliegues.html'));
const outDir = path.join(path.dirname(htmlPath), 'audio');

function fail(text) {
  console.error(text);
  process.exit(1);
}

function readClips() {
  if (!fs.existsSync(htmlPath)) fail(`No encuentro ${htmlPath}. Deja este script en la misma carpeta que asistente-pliegues.html.`);
  const html = fs.readFileSync(htmlPath, 'utf8');
  const m = html.match(/\/\/ <clips>([\s\S]*?)\/\/ <\/clips>/);
  if (!m) fail('No encontré la lista de clips dentro de la página (bloque <clips>).');
  return new Function(m[1] + '\n;return CLIPS;')();
}

const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

function ssml(text) {
  const inner = RATE && RATE !== '0%' ? `<prosody rate="${esc(RATE)}">${esc(text)}</prosody>` : esc(text);
  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="es-CR"><voice name="${esc(VOICE)}">${inner}</voice></speak>`;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function synth(text) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': KEY,
        'Content-Type': 'application/ssml+xml',
        'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3',
        'User-Agent': 'asistente-pliegues'
      },
      body: ssml(text)
    });
    if (res.ok) return Buffer.from(await res.arrayBuffer());
    const body = (await res.text().catch(() => '')).slice(0, 200);
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      await sleep(1000 * attempt);
      continue;
    }
    const err = new Error(`HTTP ${res.status} ${body}`);
    err.status = res.status;
    throw err;
  }
}

function trimSilence(file) {
  const tmp = file + '.tmp.mp3';
  const af = 'silenceremove=start_periods=1:start_threshold=-50dB,areverse,silenceremove=start_periods=1:start_threshold=-50dB,areverse';
  const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', file, '-af', af, tmp]);
  if (r.status === 0 && fs.existsSync(tmp) && fs.statSync(tmp).size > 0) fs.renameSync(tmp, file);
  else { try { fs.unlinkSync(tmp); } catch (e) { /* nada */ } }
}

(async () => {
  if (!KEY || !ENDPOINT) {
    fail('Faltan AZURE_SPEECH_KEY y AZURE_SPEECH_REGION.\n' +
      'Los encuentras en Azure Portal > tu recurso de Speech > "Claves y punto de conexión".\n' +
      'Mira el encabezado de este archivo para ver cómo ponerlas.');
  }
  const clips = readClips();
  const keys = Object.keys(clips);
  fs.mkdirSync(outDir, { recursive: true });
  const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
  console.log(`Voz: ${VOICE} · ${keys.length} clips · recorte de silencio: ${hasFfmpeg ? 'sí (ffmpeg)' : 'no (ffmpeg no está instalado)'}`);

  let made = 0, skipped = 0, failed = 0;
  for (const key of keys) {
    const file = path.join(outDir, key + '.mp3');
    if (!force && fs.existsSync(file)) { skipped++; continue; }
    try {
      fs.writeFileSync(file, await synth(clips[key]));
      if (hasFfmpeg) trimSilence(file);
      made++;
      console.log(`✓ ${key.padEnd(14)} ${clips[key]}`);
    } catch (e) {
      failed++;
      console.error(`✗ ${key}: ${e.message}`);
      if (e.status === 401 || e.status === 403) fail('La clave o la región no son correctas. Revisa AZURE_SPEECH_KEY y AZURE_SPEECH_REGION.');
      if (e.status === 404) fail('No se encontró el servicio. Revisa que AZURE_SPEECH_REGION sea la región de tu recurso (por ejemplo eastus).');
    }
  }
  console.log(`\nListo: ${made} generados, ${skipped} ya existían, ${failed} con error.`);
  console.log(`Los audios están en: ${outDir}`);
  process.exit(failed ? 1 : 0);
})();
