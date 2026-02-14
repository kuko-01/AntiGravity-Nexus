const fs = require('fs');
const path = require('path');

const targetPath = path.join(__dirname, 'main/main.ts');
let content = fs.readFileSync(targetPath, 'utf8');

// The problematic string with newline
const badString = `const match = stdoutData.match(/OUTPUT:(.+)[
]*/);`;

const fixedString = `const match = stdoutData.match(/OUTPUT:(.+)[\r\n]*/);`;

// Replace
if (content.includes(badString)) {
    content = content.replace(badString, fixedString);
    fs.writeFileSync(targetPath, content, 'utf8');
    console.log("Successfully fixed regex syntax error.");
} else {
    // Try to find it loosely if exact match fails due to line endings
    const looseMatch = /const match = stdoutData\.match\(\/OUTPUT:\(\.\+\)\[\s+\]\*\/\);/m;
    if (looseMatch.test(content)) {
        content = content.replace(looseMatch, fixedString);
        fs.writeFileSync(targetPath, content, 'utf8');
        console.log("Successfully fixed regex syntax error (loose match).");
    } else {
        console.log("Could not find the target string to fix.");
        // Print surrounding lines for debugging
        const index = content.indexOf('stdoutData.match(/OUTPUT:');
        if (index !== -1) {
            console.log("Context:");
            console.log(content.substring(index, index + 50));
        }
    }
}
