/**
 * create-stickers.js — Gera e publica pack de stickers do Squad Futbol
 *
 * Estilo: fundo branco, logo do grupo no topo, texto grande com contorno preto (Impact),
 * inspirado em packs profissionais de apostas (ex: BinaryCash).
 */

import 'dotenv/config';
import axios    from 'axios';
import FormData from 'form-data';
import sharp    from 'sharp';
import { execSync }  from 'child_process';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = join(__dirname, '..');
const TMP       = join(ROOT, 'data', 'stickers');
if (!existsSync(TMP)) mkdirSync(TMP, { recursive: true });

const TOKEN      = process.env.TELEGRAM_BOT_TOKEN;
const USER_ID    = 648357841;
const BOT_USER   = 'Futmagicboss_bot';
const PACK_VER   = process.env.STICKER_VER || 'v4';
const PACK_NAME  = `squad_futbol_${PACK_VER}_by_${BOT_USER}`;
const PACK_TITLE = 'Squad Futbol 🤖⚽';
const GROUP_PHOTO = join(ROOT, 'data', 'group-photo.png');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function log(icon, msg) { console.log(`${icon}  ${msg}`); }

// ── Definição dos 7 stickers ──────────────────────────────────────────────────
// accent: cor RGB do texto principal (sobre fundo branco — cores vivas e saturadas)
const STICKERS = [
  {
    id:    'win',
    text:  'WIN TROPA!',
    sub:   'Bilhete Verde',
    emoji: '🏆',
    accent: [220, 60, 0],    // laranja-vermelho (estilo esportes)
  },
  {
    id:    'meta',
    text:  'META BATIDA!',
    sub:   'Objetivo Alcancado',
    emoji: '🎯',
    accent: [200, 140, 0],   // dourado escuro
  },
  {
    id:    'winzao',
    text:  'WINZAO DO',
    sub:   'ROBOZAO!',
    emoji: '🤖',
    accent: [0, 100, 200],   // azul
  },
  {
    id:    'fora_maxima',
    text:  'FORA MAXIMA',
    sub:   'TROPA!',
    emoji: '🚀',
    accent: [140, 0, 200],   // roxo
  },
  {
    id:    'bilhete_win',
    text:  'BILHETE WIN',
    sub:   'Caixa Batendo!',
    emoji: '✅',
    accent: [0, 160, 50],    // verde
  },
  {
    id:    'bilhete_red',
    text:  'BILHETE RED',
    sub:   'Proximo sera WIN',
    emoji: '❌',
    accent: [200, 0, 0],     // vermelho
  },
  {
    id:    'lucro',
    text:  'LUCRO NO BOLSO',
    sub:   'Bankroll Crescendo',
    emoji: '💰',
    accent: [180, 130, 0],   // ouro
  },
];

// ── Gera sticker: fundo branco + logo no topo + texto com contorno ────────────
function buildSticker(sticker, outPath) {
  const [r, g, b] = sticker.accent;
  const mainText  = sticker.text.replace(/'/g, "''");
  const subText   = sticker.sub.replace(/'/g, "''");
  const logoPath  = GROUP_PHOTO.replace(/\\/g, '\\\\');
  const opEsc     = outPath.replace(/\\/g, '\\\\');

  // Gera linhas de outline para o texto principal (8 direções, offset 4px)
  const mainOutline = [];
  for (const dx of [-4, -2, 0, 2, 4]) {
    for (const dy of [-4, -2, 0, 2, 4]) {
      if (dx === 0 && dy === 0) continue;
      mainOutline.push(
        `$g.DrawString('${mainText}', $fMain, $oBr, ${256 + dx}, ${345 + dy}, $sf)`
      );
    }
  }

  // Gera linhas de outline para o subtexto (offset 2px)
  const subOutline = [];
  for (const dx of [-2, 0, 2]) {
    for (const dy of [-2, 0, 2]) {
      if (dx === 0 && dy === 0) continue;
      subOutline.push(
        `$g.DrawString('${subText}', $fSub, $oBr, ${256 + dx}, ${430 + dy}, $sf)`
      );
    }
  }

  const psLines = [
    `Add-Type -AssemblyName System.Drawing`,
    // Carrega a logo do grupo
    `$logo = [System.Drawing.Bitmap]::FromFile('${logoPath}')`,
    // Canvas 512x512 branco
    `$out = New-Object System.Drawing.Bitmap(512, 512)`,
    `$g = [System.Drawing.Graphics]::FromImage($out)`,
    `$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias`,
    `$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAlias`,
    `$g.Clear([System.Drawing.Color]::White)`,
    // Logo do grupo centralizada no topo (400x265 centrada em x=56)
    `$g.DrawImage($logo, 56, 5, 400, 265)`,
    // Linha separadora na cor do sticker
    `$sepPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(230, ${r}, ${g}, ${b}), 4)`,
    `$g.DrawLine($sepPen, 30, 278, 482, 278)`,
    // StringFormat centralizado
    `$sf = New-Object System.Drawing.StringFormat`,
    `$sf.Alignment = [System.Drawing.StringAlignment]::Center`,
    `$sf.LineAlignment = [System.Drawing.StringAlignment]::Center`,
    // Fontes: Impact para texto de impacto, Arial Bold para tag
    `$fMain = New-Object System.Drawing.Font('Impact', 54, [System.Drawing.FontStyle]::Regular)`,
    `$fSub  = New-Object System.Drawing.Font('Impact', 22, [System.Drawing.FontStyle]::Regular)`,
    `$fTag  = New-Object System.Drawing.Font('Arial',  10, [System.Drawing.FontStyle]::Bold)`,
    // Brushes
    `$mBr = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, ${r}, ${g}, ${b}))`,
    `$oBr = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::Black)`,
    `$wBr = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)`,
    `$gBr = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(100, 100, 100))`,
    // Outline do texto principal
    ...mainOutline,
    // Texto principal na cor do sticker
    `$g.DrawString('${mainText}', $fMain, $mBr, 256, 345, $sf)`,
    // Outline do subtexto
    ...subOutline,
    // Subtexto em branco (sobre outline preto fica legível)
    `$g.DrawString('${subText}', $fSub, $wBr, 256, 430, $sf)`,
    // Tag "Squad Futbol" em cinza no rodapé
    `$g.DrawString('Squad Futbol', $fTag, $gBr, 256, 492, $sf)`,
    // Salva e libera
    `$g.Dispose()`,
    `$logo.Dispose()`,
    `$out.Save('${opEsc}', [System.Drawing.Imaging.ImageFormat]::Png)`,
    `$out.Dispose()`,
    `Write-Host 'OK'`,
  ];

  const ps1Path = join(TMP, `build_${sticker.id}.ps1`);
  writeFileSync(ps1Path, psLines.join('\r\n'), 'utf8');

  const result = execSync(
    `powershell -ExecutionPolicy Bypass -WindowStyle Hidden -File "${ps1Path}"`,
    { encoding: 'utf8', windowsHide: true, timeout: 20000 }
  ).trim();

  if (!result.includes('OK')) throw new Error(`PowerShell retornou: ${result}`);
}

// ── Converte para WebP (Telegram: limite ~512KB, WebP é muito menor) ──────────
async function toWebp(inputPath, outputPath) {
  await sharp(inputPath)
    .resize(512, 512, { fit: 'cover' })
    .webp({ quality: 82, effort: 6 })
    .toFile(outputPath);
  const size = readFileSync(outputPath).length;
  log('🗜️', `WebP: ${Math.round(size / 1024)}KB`);
}

// ── Upload para Telegram ──────────────────────────────────────────────────────
async function uploadSticker(filePath) {
  const form = new FormData();
  form.append('user_id', USER_ID);
  form.append('sticker', readFileSync(filePath), {
    filename: 'sticker.webp',
    contentType: 'image/webp',
  });
  form.append('sticker_format', 'static');

  const res = await axios.post(
    `https://api.telegram.org/bot${TOKEN}/uploadStickerFile`,
    form,
    { headers: form.getHeaders(), timeout: 30000 }
  );
  return res.data.result.file_id;
}

// ── Pipeline principal ────────────────────────────────────────────────────────
async function run() {
  console.log('\n' + '═'.repeat(60));
  console.log('  🤖 CRIANDO STICKER PACK — Squad Futbol (estilo profissional)');
  console.log('═'.repeat(60) + '\n');

  const fileIds = [];

  for (let i = 0; i < STICKERS.length; i++) {
    const s        = STICKERS[i];
    const pngPath  = join(TMP, `sticker_${s.id}.png`);
    const webpPath = join(TMP, `compressed_${s.id}.webp`);

    console.log(`\n[${i + 1}/${STICKERS.length}] ${s.text}`);

    // Gera PNG
    log('🎨', 'Gerando sticker...');
    try {
      buildSticker(s, pngPath);
      log('✅', 'PNG gerado');
    } catch (e) {
      log('❌', `Falhou: ${e.message}`);
      continue;
    }

    // Converte para WebP
    try {
      await toWebp(pngPath, webpPath);
    } catch (e) {
      log('⚠️', `WebP falhou: ${e.message} — abortando sticker`);
      continue;
    }

    // Upload
    log('📤', 'Fazendo upload para Telegram...');
    try {
      const fileId = await uploadSticker(webpPath);
      fileIds.push({ sticker: s, fileId });
      log('✅', `Upload OK — ${fileId.substring(0, 22)}...`);
    } catch (e) {
      log('❌', `Upload falhou: ${e?.response?.data?.description || e.message}`);
    }

    await sleep(1000);
  }

  if (fileIds.length === 0) {
    log('❌', 'Nenhum sticker gerado.');
    return;
  }

  // Cria o pack com o primeiro sticker
  console.log('\n' + '─'.repeat(60));
  log('🚀', `Criando pack "${PACK_NAME}"...`);

  const first = fileIds[0];
  try {
    await axios.post(`https://api.telegram.org/bot${TOKEN}/createNewStickerSet`, {
      user_id:  USER_ID,
      name:     PACK_NAME,
      title:    PACK_TITLE,
      stickers: [{ sticker: first.fileId, format: 'static', emoji_list: [first.sticker.emoji] }],
    });
    log('✅', 'Pack criado!');
  } catch (e) {
    log('❌', `Criação falhou: ${e?.response?.data?.description || e.message}`);
    return;
  }

  log('⏳', 'Aguardando propagação (5s)...');
  await sleep(5000);

  // Adiciona os demais
  for (const { sticker, fileId } of fileIds.slice(1)) {
    try {
      await axios.post(`https://api.telegram.org/bot${TOKEN}/addStickerToSet`, {
        user_id: USER_ID,
        name:    PACK_NAME,
        sticker: { sticker: fileId, format: 'static', emoji_list: [sticker.emoji] },
      });
      log('➕', `Adicionado: ${sticker.text}`);
      await sleep(600);
    } catch (e) {
      log('⚠️', `${sticker.text}: ${e?.response?.data?.description || e.message}`);
    }
  }

  console.log('\n' + '═'.repeat(60));
  console.log('  ✅ STICKER PACK CRIADO COM SUCESSO!');
  console.log(`  Link: https://t.me/addstickers/${PACK_NAME}`);
  console.log('═'.repeat(60) + '\n');
}

run().catch(e => {
  console.error('Erro fatal:', e.message);
  process.exit(1);
});
