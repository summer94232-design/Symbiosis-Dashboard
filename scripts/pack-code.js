// 執行方式：node scripts/pack-code.js
import fs from 'fs';
import path from 'path';

// 設定你要讓我看的資料夾
const targetDirs = ['./src/lib', './src/pages/invest']; 
const outputFile = 'ai_dev_prompt.txt';

let outputContent = '【共生系統程式碼打包】\n\n';

function readFiles(dir) {
    const files = fs.readdirSync(dir);
    files.forEach(file => {
        const fullPath = path.join(dir, file);
        if (fs.statSync(fullPath).isDirectory()) {
            readFiles(fullPath);
        } else if (/\.(tsx|ts|js)$/.test(file)) { // 只抓取程式碼檔
            const content = fs.readFileSync(fullPath, 'utf-8');
            outputContent += `\n/* =========================================\n`;
            outputContent += ` * 檔案位置: ${fullPath}\n`;
            outputContent += ` * ========================================= */\n\n`;
            outputContent += content + '\n\n';
        }
    });
}

targetDirs.forEach(dir => readFiles(dir));
fs.writeFileSync(outputFile, outputContent);
console.log(`✅ 程式碼已打包至 ${outputFile}，可以直接上傳給 AI 囉！`);