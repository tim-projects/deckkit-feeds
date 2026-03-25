const fs = require('fs');

function compareDecks(file1, file2) {
    if (!fs.existsSync(file1)) {
        console.error(`${file1} not found. Assuming content has changed.`);
        process.exit(0);
    }
    
    if (!fs.existsSync(file2)) {
        console.error(`${file2} not found. Assuming content has changed.`);
        process.exit(0);
    }

    const deck1 = JSON.parse(fs.readFileSync(file1, 'utf-8'));
    const deck2 = JSON.parse(fs.readFileSync(file2, 'utf-8'));

    const items1 = JSON.stringify(deck1.items);
    const items2 = JSON.stringify(deck2.items);

    if (items1 === items2) {
        console.log("Demo deck content has not changed.");
        process.exit(1); // Exit with 1 to indicate no changes
    } else {
        console.log("Demo deck content has changed.");
        process.exit(0); // Exit with 0 to indicate changes
    }
}

const [file1, file2] = process.argv.slice(2);
if (!file1 || !file2) {
    console.error("Usage: node compare-decks.js <file1> <file2>");
    process.exit(1);
}

compareDecks(file1, file2);
