import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const rootDir = new URL('.', import.meta.url).pathname;
const allowedExtensions = new Set(['.csv', '.pdf']);

function sanitizeFilename(name = '') {
  const base = String(name).split(/[\\/]/).pop() || 'upload.dat';
  return base.replace(/[^a-zA-Z0-9._()\-\s]/g, '_').slice(0, 180);
}

function parseMultipart(buffer, contentType = '') {
  const boundaryMatch = contentType.match(/boundary=(?:(?:"([^"]+)")|([^;]+))/i);
  if (!boundaryMatch) {
    throw new Error('Missing multipart boundary');
  }

  const boundary = `--${boundaryMatch[1] || boundaryMatch[2]}`;
  const body = buffer.toString('latin1');
  const parts = body.split(boundary).slice(1, -1);

  return parts
    .map((part) => part.replace(/^\r\n/, '').replace(/\r\n$/, ''))
    .map((part) => {
      const separatorIndex = part.indexOf('\r\n\r\n');
      if (separatorIndex === -1) return null;

      const rawHeaders = part.slice(0, separatorIndex);
      const rawContent = part.slice(separatorIndex + 4);
      const disposition = rawHeaders.match(/content-disposition:\s*form-data;([^\r\n]+)/i)?.[1] || '';
      const filename = disposition.match(/filename="([^"]*)"/i)?.[1];
      if (!filename) return null;

      return {
        filename,
        content: Buffer.from(rawContent, 'latin1'),
      };
    })
    .filter(Boolean);
}

function uploadDataMiddleware() {
  return async (req, res, next) => {
    if (req.method !== 'POST' || req.url !== '/api/upload-data') {
      next();
      return;
    }

    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const files = parseMultipart(Buffer.concat(chunks), req.headers['content-type']);

      if (!files.length) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: false, error: 'No files uploaded' }));
        return;
      }

      const publicDataDir = resolve(rootDir, 'public/data');
      const distDataDir = resolve(rootDir, 'dist/data');
      mkdirSync(publicDataDir, { recursive: true });
      if (existsSync(resolve(rootDir, 'dist'))) {
        mkdirSync(distDataDir, { recursive: true });
      }

      const saved = [];
      const rejected = [];

      for (const file of files) {
        const filename = sanitizeFilename(file.filename);
        const extension = extname(filename).toLowerCase();
        if (!allowedExtensions.has(extension)) {
          rejected.push({ filename, reason: 'Only .csv and .pdf files are allowed' });
          continue;
        }

        const targets = [join(publicDataDir, filename)];
        if (existsSync(resolve(rootDir, 'dist'))) {
          targets.push(join(distDataDir, filename));
        }

        for (const target of targets) {
          writeFileSync(target, file.content);
        }

        saved.push({
          filename,
          size: file.content.length,
          paths: targets.map((target) => target.replace(rootDir, '')),
        });
      }

      res.statusCode = saved.length ? 200 : 400;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: Boolean(saved.length), saved, rejected }));
    } catch (error) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: false, error: error.message }));
    }
  };
}

const dataUploadPlugin = () => ({
  name: 'agent-foundry-data-upload',
  configureServer(server) {
    server.middlewares.use(uploadDataMiddleware());
  },
  configurePreviewServer(server) {
    server.middlewares.use(uploadDataMiddleware());
  },
});

export default defineConfig({
  plugins: [react(), dataUploadPlugin()],
});
