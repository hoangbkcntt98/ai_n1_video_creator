const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { framesToVideo } = require('./frames-to-video');

const FPS = Number(process.env.FPS || 25);
const DURATION = Number(process.env.DURATION || 5);

(async () => {
  if (!Number.isInteger(FPS) || FPS < 1 || !Number.isFinite(DURATION) || DURATION <= 0) {
    throw new Error('FPS phải là số nguyên dương; DURATION phải lớn hơn 0.');
  }
  const browser = await puppeteer.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1080, height: 1920, deviceScaleFactor: 1 });
    const url = pathToFileURL(path.join(__dirname, 'kanji.html'));
    url.searchParams.set('export', '1');
    await page.goto(url.href, { waitUntil: 'networkidle0' });
    await page.evaluate(async () => {
      await document.fonts.ready;
      await Promise.all(Array.from(document.images, img => img.decode().catch(() => {})));
    });
    // Tuỳ chọn: node html-to-image.js quiz.json
    // JSON: {"Word":"遭う","AnswerA":"あう","AnswerB":"そうう","AnswerC":"あえる","AnswerD":"かう"}
    if (process.argv[2]) {
      const data = JSON.parse(fs.readFileSync(path.resolve(process.argv[2]), 'utf8'));
      await page.evaluate(data => window.setQuiz(data), data);
    }
    await page.evaluate(() => window.fitText());
    const reel = await page.$('#reel');
    if (!reel) throw new Error('Không tìm thấy #reel.');
    const bounds = await reel.boundingBox();
    if (bounds.width !== 1080 || bounds.height !== 1920) throw new Error('Canvas phải là 1080×1920.');
    // Tách GIF khỏi ảnh chụp. Đo vị trí thật để FFmpeg ghép đúng bố cục.
    const gif = path.join(__dirname, 'spinning-bear.gif');
    let overlay = null;
    if (fs.existsSync(gif)) {
      const box = await page.evaluate(() => {
        const reel = document.querySelector('#reel').getBoundingClientRect();
        const person = document.querySelector('.person-wrap');
        const box = person.getBoundingClientRect();
        person.style.visibility = 'hidden';
        return { x: Math.round(box.x-reel.x), y: Math.round(box.y-reel.y),
          width: Math.round(box.width), height: Math.round(box.height) };
      });
      overlay = { gif, ...box };
      if (FPS % 25 !== 0) console.warn('GIF này có frame 80 ms; dùng FPS=25 hoặc 50 để giữ đúng từng mốc chuyển động.');
    }
    // Mỗi lần chạy dùng thư mục riêng, tránh trộn các frame cũ.
    const output = path.join(__dirname, 'frames', new Date().toISOString().replace(/[:.]/g, '-'));
    fs.mkdirSync(output, { recursive: true });
    const count = Math.round(FPS * DURATION);
    if (count < 1) throw new Error('DURATION quá ngắn cho FPS đã chọn.');
    for (let i = 0; i < count; i++) {
      // Đồng hồ bám theo chỉ số frame, không trôi do thời gian screenshot.
      await page.evaluate(({ time, duration }) => window.renderFrame(time, duration), {
        time: i / FPS, duration: DURATION
      });
      await reel.screenshot({ path: path.join(output, `frame_${String(i).padStart(4, '0')}.png`) });
    }
    console.log(`Đã xuất ${count} frame 1080×1920: ${output}`);
    // GIF được đọc trực tiếp từ file, độc lập với tốc độ Puppeteer.
    framesToVideo(output, path.join(output, 'video.mp4'), FPS, overlay);
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
