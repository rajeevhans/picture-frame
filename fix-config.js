#!/usr/bin/env node
/**
 * Fix config.json file by removing Git merge conflict markers
 */

const fs = require('fs');
const path = require('path');

const configPath = path.join(__dirname, 'config.json');

try {
    let content = fs.readFileSync(configPath, 'utf8');
    
    // Check for merge conflict markers
    if (content.includes('<<<<<<<') || content.includes('>>>>>>>') || content.includes('=======')) {
        console.log('Found merge conflict markers in config.json');
        console.log('Attempting to fix...');
        
        // Remove merge conflict markers and keep the "Updated upstream" version (last section)
        const lines = content.split('\n');
        const fixedLines = [];
        let inConflict = false;
        let conflictStart = -1;
        let conflictEnd = -1;
        
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            
            if (line.startsWith('<<<<<<<')) {
                inConflict = true;
                conflictStart = i;
                continue;
            }
            
            if (line.startsWith('=======') && inConflict) {
                // Middle of conflict - skip everything until >>>>>>>
                continue;
            }
            
            if (line.startsWith('>>>>>>>') && inConflict) {
                inConflict = false;
                conflictStart = -1;
                conflictEnd = -1;
                continue;
            }
            
            if (!inConflict) {
                fixedLines.push(lines[i]);
            }
        }
        
        const fixedContent = fixedLines.join('\n');
        
        // Validate JSON
        try {
            JSON.parse(fixedContent);
            fs.writeFileSync(configPath, fixedContent, 'utf8');
            console.log('✓ Fixed config.json successfully');
        } catch (parseError) {
            console.error('✗ Fixed content is not valid JSON:', parseError.message);
            console.log('\nFixed content:');
            console.log(fixedContent);
            process.exit(1);
        }
    } else {
        // Validate existing JSON
        try {
            JSON.parse(content);
            console.log('✓ config.json is valid (no conflicts found)');
        } catch (parseError) {
            console.error('✗ config.json contains invalid JSON:', parseError.message);
            console.error('Error at position:', parseError.message);
            process.exit(1);
        }
    }
} catch (error) {
    console.error('Error reading config.json:', error.message);
    process.exit(1);
}
