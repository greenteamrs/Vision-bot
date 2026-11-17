const { createCanvas } = require('@napi-rs/canvas');

function wrapped(ctx, text, x, y, width, maxLines) {
  const words = text.split(/\s+/);
  const lines = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (ctx.measureText(next).width > width && line) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  lines.slice(0, maxLines).forEach((value, index) => {
    ctx.fillText(index === maxLines - 1 && lines.length > maxLines ? `${value.slice(0, -3)}…` : value,
      x, y + index * 23, width);
  });
}

function renderCalendar(config, run) {
  const canvas = createCanvas(1200, 1120);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#101e1b';
  ctx.fillRect(0, 0, 1200, 1120);
  ctx.textAlign = 'center';
  ctx.fillStyle = '#dabe81';
  ctx.font = 'bold 42px sans-serif';
  ctx.fillText('VISION • ADVENT CHALLENGES', 600, 65);
  ctx.fillStyle = '#b2c7bf';
  ctx.font = '22px sans-serif';
  ctx.fillText(`December 1–25, ${config.year} • UTC • TEST CALENDAR`, 600, 105);
  for (let day = 1; day <= 25; day++) {
    const x = 40 + ((day - 1) % 5) * 226;
    const y = 145 + Math.floor((day - 1) / 5) * 180;
    const opened = day <= run.opened;
    const current = day === run.day;
    ctx.fillStyle = opened ? '#284b40' : '#192f29';
    ctx.fillRect(x, y, 212, 164);
    ctx.strokeStyle = current ? '#f0ce89' : opened ? '#678e77' : '#40534a';
    ctx.lineWidth = current ? 4 : 1;
    ctx.strokeRect(x, y, 212, 164);
    ctx.fillStyle = opened ? '#f0ce89' : '#a1b5a8';
    ctx.font = `bold ${opened ? 26 : 52}px sans-serif`;
    ctx.fillText(String(day).padStart(2, '0'), x + 106, y + (opened ? 35 : 93));
    if (opened) {
      ctx.fillStyle = '#e5eee7';
      ctx.font = '18px sans-serif';
      wrapped(ctx, config.challenges[day - 1], x + 106, y + 65, 184, 4);
      // Door leaf: an open door is visually distinct from a numbered, closed panel.
      ctx.fillStyle = '#718368';
      ctx.beginPath();
      ctx.moveTo(x + 6, y + 12);
      ctx.lineTo(x + 22, y + 22);
      ctx.lineTo(x + 22, y + 144);
      ctx.lineTo(x + 6, y + 154);
      ctx.fill();
    } else {
      ctx.fillStyle = '#b39358';
      ctx.beginPath();
      ctx.arc(x + 188, y + 90, 4, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.fillStyle = '#b2c7bf';
  ctx.font = '19px sans-serif';
  ctx.fillText('Only the current day accepts proof • Future challenges remain behind closed doors', 600, 1080);
  return canvas.toBuffer('image/png');
}

module.exports = { renderCalendar };
