const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function framesToVideo(directory, outputFile, fps = 25, overlay = null) {
  fps = Number(fps);
  if (!Number.isInteger(fps) || fps < 1) throw new Error('FPS phải là số nguyên dương.');
  const dir = path.resolve(directory);
  const output = path.resolve(outputFile || path.join(dir, 'video.mp4'));
  const frames = fs.readdirSync(dir).filter(name => /^frame_\d{4,}\.png$/.test(name))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
  if (!frames.length) throw new Error('Không tìm thấy frame_0000.png, frame_0001.png, ...');
  frames.forEach((name, i) => {
    if (name !== `frame_${String(i).padStart(4, '0')}.png`) {
      throw new Error(`Thiếu hoặc sai tên frame ở vị trí ${i}. Chuỗi phải liên tục từ frame_0000.png.`);
    }
  });
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const extraInputs = [];
  let filters = ['-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2'];
  if (overlay) {
    const { x, y, width, height } = overlay;
    if (![x,y,width,height].every(Number.isInteger) || x < 0 || y < 0 || width < 1 || height < 1) {
      throw new Error('Vị trí và kích thước GIF không hợp lệ.');
    }
    if (!fs.existsSync(overlay.gif)) throw new Error('Không tìm thấy GIF: ' + overlay.gif);
    extraInputs.push('-stream_loop', '-1', '-ignore_loop', '1', '-i', path.resolve(overlay.gif));
    // Giữ timestamp gốc của GIF; chỉ lấy mẫu khi ghép vào video.
    filters = ['-filter_complex',
      `[0:v]setpts=PTS-STARTPTS[bg];[1:v]setpts=PTS-STARTPTS,scale=${width}:${height}:force_original_aspect_ratio=decrease,format=rgba,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black@0[bear];[bg][bear]overlay=x=${x}:y=${y}:shortest=1:format=auto,pad=ceil(iw/2)*2:ceil(ih/2)*2[out]`,
      '-map', '[out]'];
  }
  const result = spawnSync(process.env.FFMPEG_PATH || 'ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-n',
    '-framerate', String(fps), '-start_number', '0',
    '-i', path.join(dir, 'frame_%04d.png'),
    ...extraInputs,
    '-frames:v', String(frames.length), '-an',
    ...filters,
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '18',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', output
  ], { stdio: 'inherit' });
  if (result.error) throw new Error(`Không chạy được FFmpeg. Cài FFmpeg và thêm vào PATH, hoặc đặt FFMPEG_PATH. ${result.error.message}`);
  if (result.status !== 0) throw new Error('FFmpeg thất bại. Kiểm tra lỗi phía trên; file đích đã tồn tại sẽ không bị ghi đè.');
  console.log(`Đã tạo MP4: ${output} (${frames.length} frame, ${fps} FPS, ${(frames.length / fps).toFixed(2)} giây)`);
  return output;
}

module.exports = { framesToVideo };
if (require.main === module) {
  const [, , directory, output, fps] = process.argv;
  if (!directory) {
    console.error('Cách dùng: node frames-to-video.js "thư-mục-frame" "video.mp4" 15');
    process.exitCode = 1;
  } else {
    try { framesToVideo(directory, output, fps || 25); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
