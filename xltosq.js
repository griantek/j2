const xlsx = require('xlsx');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// Function to read the Excel file and extract 'Source Title' column
function loadTitlesFromExcel(excelFile, sheetName = 'Scopus Sources Oct. 2024') {
    const workbook = xlsx.readFile(excelFile);
    const sheet = workbook.Sheets[sheetName];
    const jsonData = xlsx.utils.sheet_to_json(sheet);

    // Assuming the 'Source Title' column exists
    return jsonData.map(row => row['Source Title']).filter(title => title !== undefined);
}

// Function to insert titles into SQLite
function insertTitlesIntoSQLite(titles) {
    const dbPath = 'scopus_sources.db';
    const db = new sqlite3.Database(dbPath);

    // Create the 'sources' table if it doesn't exist
    db.run(`
        CREATE TABLE IF NOT EXISTS sources (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            source_title TEXT
        )
    `);

    // Insert the titles into the database
    const stmt = db.prepare('INSERT INTO sources (source_title) VALUES (?)');
    
    titles.forEach(title => {
        stmt.run(title);
    });

    stmt.finalize();
    db.close();

    console.log(`Successfully inserted ${titles.length} source titles into the database.`);
}

// Main function
function main() {
    const excelFile = 'title.xlsx';  // Path to your Excel file
    const titles = loadTitlesFromExcel(excelFile);

    if (titles.length > 0) {
        insertTitlesIntoSQLite(titles);
    } else {
        console.log('No titles found in the Excel file.');
    }
}

// Run the main function
main();
