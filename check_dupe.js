const fs = require('fs');
const path = 'c:\\Users\\skyfo\\.gemini\\test\\main\\main.ts';
try {
    const content = fs.readFileSync(path, 'utf-8');
    const lines = content.split('\n');
    console.log(`Checking file: ${path}`);
    let count = 0;
    lines.forEach((line, index) => {
        if (line.includes('read-audio-file')) {
            console.log(`Line ${index + 1}: ${line.trim()}`);
            count++;
        }
    });
    console.log(`Total matches: ${count}`);
} catch (err) {
    console.error(err);
}
