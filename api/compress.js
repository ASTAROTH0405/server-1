import fetch from 'node-fetch';
import sharp from 'sharp';
import { AbortController } from 'abort-controller';
import fs from 'fs/promises';
import path from 'path';

// --- CONFIGURACIÓN FINAL ---
const MAX_INPUT_SIZE_BYTES = 30 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15000; // 15 segundos es un buen equilibrio
const MAX_IMAGE_WIDTH = 1080;

// --- HEADERS GENÉRICOS DE NAVEGADOR (Los más compatibles) ---
function getHeaders(domain) {
  return {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
    'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
    'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
    'Referer': domain ? domain + '/' : 'https://www.google.com/'
  };
}

export default async function handler(req, res) {
  if (req.url.includes('favicon')) {
    return res.status(204).send(null);
  }
  
  const { url: imageUrl } = req.query;

  if (!imageUrl) {
    return res.status(400).json({ error: 'Falta el parámetro url' });
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const parsedUrl = new URL(imageUrl);
    const domain = parsedUrl.origin;
    
    const response = await fetch(imageUrl, {
      signal: controller.signal,
      headers: getHeaders(domain)
    });

    if (!response.ok) throw new Error(`Error al obtener la imagen: ${response.status} ${response.statusText}`);

    const originalContentTypeHeader = response.headers.get('content-type');
    if (!originalContentTypeHeader || !originalContentTypeHeader.startsWith('image/')) {
      throw new Error(`La URL no devolvió una imagen válida. Content-Type: ${originalContentTypeHeader || 'ninguno'}`);
    }
    
    const arrayBuffer = await response.arrayBuffer();
    const originalBuffer = Buffer.from(arrayBuffer);
    
    const originalSize = originalBuffer.length;
    if (originalSize === 0) throw new Error("La imagen descargada está vacía (0 bytes).");
    if (originalSize > MAX_INPUT_SIZE_BYTES) throw new Error(`La imagen excede el límite de tamaño.`);

    const metadata = await sharp(originalBuffer).metadata();
    if (metadata.pages && metadata.pages > 1) {
      return sendOriginal(res, originalBuffer, originalContentTypeHeader);
    }
    
    // --- LÓGICA DE COMPRESIÓN COMPETITIVA ---
    const baseProcessor = sharp(originalBuffer)
      .trim()
      .resize({ width: MAX_IMAGE_WIDTH, withoutEnlargement: true })
      .png({ colours: 256 }); // Quantization para máxima compresión

    // Comprimimos a AMBOS formatos en paralelo
    const [avifBuffer, webpBuffer] = await Promise.all([
      baseProcessor.clone().avif({ quality: 45 }).toBuffer(),
      baseProcessor.clone().webp({ quality: 50 }).toBuffer()
    ]);
    
    // Elegimos el ganador
    let winner, winnerContentType;
    if (avifBuffer.length < webpBuffer.length) {
      winner = avifBuffer;
      winnerContentType = 'image/avif';
    } else {
      winner = webpBuffer;
      winnerContentType = 'image/webp';
    }

    const compressedSize = winner.length;

    if (compressedSize < originalSize) {
      return sendCompressed(res, winner, originalSize, compressedSize, winnerContentType);
    } else {
      return sendOriginal(res, originalBuffer, originalContentTypeHeader);
    }
    
  } catch (error) {
    console.error("[FALLBACK ACTIVADO]", { url: imageUrl, errorMessage: error.message });
    res.setHeader('Location', imageUrl);
    res.status(302).send('Redireccionando a la fuente original por un error.');
  } finally {
    clearTimeout(timeoutId);
  }
}

// --- LAS FUNCIONES HELPER QUE FALTABAN ---
function sendCompressed(res, buffer, originalSize, compressedSize, contentType) {
  res.setHeader('Cache-Control', 's-maxage=31536000, stale-while-revalidate');
  res.setHeader('Content-Type', contentType);
  res.setHeader('X-Original-Size', originalSize);
  res.setHeader('X-Compressed-Size', compressedSize);
  res.send(buffer);
}

function sendOriginal(res, buffer, contentType) {
  res.setHeader('Cache-Control', 's-maxage=31536000, stale-while-revalidate');
  res.setHeader('Content-Type', contentType);
  res.setHeader('X-Original-Size', buffer.length);
  res.setHeader('X-Compressed-Size', buffer.length);
  res.send(buffer);
               }
