const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const targetDir = path.resolve(__dirname, '../../brain/836c1035-3075-4cec-a0c4-5fd731b05301');

if (!fs.existsSync(edgePath)) {
  console.error('Edge browser not found at:', edgePath);
  process.exit(1);
}

// Ensure target directory exists
if (!fs.existsSync(targetDir)) {
  fs.mkdirSync(targetDir, { recursive: true });
}

console.log('Using Edge at:', edgePath);

function captureScreenshot(filename, windowSize = '1280,1000') {
  const outputPath = path.join(targetDir, filename);
  const cmd = `"${edgePath}" --headless --disable-gpu --window-size=${windowSize} --screenshot="${outputPath}" "http://localhost:3000"`;
  console.log(`Running: ${cmd}`);
  execSync(cmd);
  console.log(`Saved screenshot to: ${outputPath}`);
  return outputPath;
}

try {
  captureScreenshot('foreign_buy_screenshot.png');
} catch (e) {
  console.error('Capture failed:', e);
}
