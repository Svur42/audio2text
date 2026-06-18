/**
 * prebuild 脚本：下载 Python embeddable package 并配置好 site-packages。
 * 只在 build/python-embed/ 不存在时运行一次，之后构建直接复用。
 */
'use strict';
const https = require('https');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');
const { execSync } = require('child_process');

const PYTHON_VERSION = '3.12.10';
const DOWNLOAD_URL   = `https://www.python.org/ftp/python/${PYTHON_VERSION}/python-${PYTHON_VERSION}-embed-amd64.zip`;
const BUILD_DIR      = path.join(__dirname, '..', 'build');
const EMBED_DIR      = path.join(BUILD_DIR, 'python-embed');
const ZIP_PATH       = path.join(BUILD_DIR, 'python-embed.zip');

function download(url, dest, redirects = 0) {
  if (redirects > 5) return Promise.reject(new Error('Too many redirects'));
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    proto.get(url, { timeout: 30000 }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return download(res.headers.location, dest, redirects + 1).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const file = fs.createWriteStream(dest);
      let downloaded = 0;
      res.on('data', (chunk) => {
        downloaded += chunk.length;
        process.stdout.write(`\r  ${(downloaded / 1024 / 1024).toFixed(1)} MB`);
      });
      res.pipe(file);
      file.on('finish', () => { file.close(); process.stdout.write('\n'); resolve(); });
      file.on('error', reject);
    }).on('error', reject).on('timeout', () => reject(new Error('Download timeout')));
  });
}

async function main() {
  if (fs.existsSync(EMBED_DIR) && fs.existsSync(path.join(EMBED_DIR, 'python.exe'))) {
    console.log(`[python-embed] Already set up at ${EMBED_DIR}, skipping.`);
    return;
  }

  console.log(`[python-embed] Downloading Python ${PYTHON_VERSION} embeddable...`);
  fs.mkdirSync(BUILD_DIR, { recursive: true });
  await download(DOWNLOAD_URL, ZIP_PATH);

  console.log('[python-embed] Extracting...');
  fs.mkdirSync(EMBED_DIR, { recursive: true });
  execSync(
    `powershell -NoProfile -Command "Expand-Archive -LiteralPath '${ZIP_PATH}' -DestinationPath '${EMBED_DIR}' -Force"`,
    { stdio: 'inherit' }
  );
  fs.unlinkSync(ZIP_PATH);

  // 启用 site-packages（解注释 _pth 文件中的 import site）
  const pthFiles = fs.readdirSync(EMBED_DIR).filter(f => /python\d+\._pth$/i.test(f));
  for (const f of pthFiles) {
    const p = path.join(EMBED_DIR, f);
    const content = fs.readFileSync(p, 'utf8').replace('#import site', 'import site');
    fs.writeFileSync(p, content, 'utf8');
  }

  console.log(`[python-embed] Done. Python ${PYTHON_VERSION} is ready at ${EMBED_DIR}`);
}

main().catch(err => {
  console.error('[python-embed] Setup failed:', err.message);
  process.exit(1);
});
