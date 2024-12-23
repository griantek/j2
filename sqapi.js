
import sqlite3 from 'sqlite3';
const { Database } = sqlite3;
import readline from 'readline';
import fetch from 'node-fetch';

// Function to fetch titles from SQLite
function fetchTitlesFromDatabase(dbPath = 'scopus_sources.db') {
    return new Promise((resolve, reject) => {
        const db = new Database(dbPath, Database.OPEN_READONLY, (err) => {
            if (err) {
                reject(`Error opening database: ${err.message}`);
            }
        });

        const query = 'SELECT source_title FROM sources';

        db.all(query, [], (err, rows) => {
            if (err) {
                reject(`Error fetching data: ${err.message}`);
            } else {
                const titles = rows.map(row => row.source_title);
                resolve(titles);
            }
            db.close();
        });
    });
}

// Function to generate combinations
function* combinations(arr, size) {
    for (let i = 0; i < arr.length; i++) {
        if (size === 1) {
            yield [arr[i]];
        } else {
            const remaining = arr.slice(i + 1);
            for (const comb of combinations(remaining, size - 1)) {
                yield [arr[i], ...comb];
            }
        }
    }
}

// Search for titles matching keywords
function searchTitles(titles, keywords) {
    const normalizedKeywords = keywords.map(kw => kw.toLowerCase().trim());
    const results = [];
    const seen = new Set();

    // Function to check if a title contains all given keywords
    const matchesAllKeywords = (title, kwList) => {
        const lowerTitle = title.toLowerCase();
        return kwList.every(kw => lowerTitle.includes(kw));
    };

    // Iterate through decreasing sizes of keyword subsets
    for (let size = normalizedKeywords.length; size > 0; size--) {
        for (const subset of combinations(normalizedKeywords, size)) {
            const matchedTitles = titles.filter(title => matchesAllKeywords(title, subset));

            matchedTitles.forEach(title => {
                if (!seen.has(title)) {
                    results.push(title);
                    seen.add(title); // Ensure no duplicates
                }
            });

            if (results.length > 0) break; // Stop if matches found
        }

        if (results.length > 0) break; // Stop if matches found
    }

    return results;
}

// API URL for journal search
const url = "https://api.elsevier.com/content/serial/title";

// Function to fetch journal data
async function fetchJournalData(title) {
    const params = new URLSearchParams({
        title: title,  // Search term for journal title
        apiKey: "718bcc88d9301d08994dfaded3291e39", // Your API key
        view: "STANDARD"  // Use "ENHANCED" for more details
    });

    try {
        const response = await fetch(`${url}?${params}`, {
            headers: { "Accept": "application/json" }
        });

        if (response.ok) {
            const data = await response.json();
            const journals = data["serial-metadata-response"].entry;
            if (!journals || journals.length === 0) {
                return null; // Return null if no journals are found
            }

            const journal = journals[0]; // Assume we get one journal for the title
            const title = journal["dc:title"] || "N/A";
            let citeScore = "N/A";
            const citeScoreYearInfo = journal["citeScoreYearInfoList"];
            if (citeScoreYearInfo && citeScoreYearInfo["citeScoreCurrentMetric"]) {
                citeScore = parseFloat(citeScoreYearInfo["citeScoreCurrentMetric"]);
            }

            const sourceLink = journal.link.find(link => link["@ref"] === "scopus-source");
            const scopusLink = sourceLink ? sourceLink["@href"] : "N/A";

            return {
                title,
                citeScore,
                scopusLink
            };
        } else {
            console.log(`Error: ${response.status} - ${response.statusText}`);
            return null;
        }
    } catch (error) {
        console.error("Error fetching data:", error);
        return null;
    }
}

// Main function
async function main() {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    try {
        const titles = await fetchTitlesFromDatabase('scopus_sources.db');

        // Prompt user for search keywords
        rl.question("Enter search keywords (separated by space): ", async (userQuery) => {
            const keywords = userQuery.split(" "); // Split user query into keywords

            console.log("Searching for titles...");
            const searchResults = searchTitles(titles, keywords);

            if (searchResults.length > 0) {
                console.log("\nMatching Titles:");
                searchResults.forEach((title, index) => {
                    console.log(`${index + 1}. ${title}`);
                });

                // Fetch journal data for the matched titles
                const journalData = [];
                for (const title of searchResults) {
                    const journal = await fetchJournalData(title);
                    if (journal) {
                        journalData.push(journal);
                    }
                }

                // Sort journals by CiteScore in descending order
                journalData.sort((a, b) => {
                    // If citeScore is "N/A", treat it as a number that is smaller than any number
                    if (a.citeScore === "N/A") return 1;
                    if (b.citeScore === "N/A") return -1;
                    return b.citeScore - a.citeScore;
                });

                // Select the top 10 journals
                const top10Journals = journalData.slice(0, 10);

                // Print the top 10 journals
                if (top10Journals.length > 0) {
                    console.log("\nTop 10 Journals based on CiteScore:");
                    top10Journals.forEach((journal, index) => {
                        console.log(`${index + 1}. Title: ${journal.title}`);
                        console.log(`   CiteScore: ${journal.citeScore}`);
                        console.log(`   Source Link: ${journal.scopusLink}\n`);
                    });
                } else {
                    console.log("No journals found.");
                }
            } else {
                console.log("No matching titles found.");
            }

            rl.close();
        });
    } catch (error) {
        console.error("Error:", error);
    }
}

// Run the main function
main();
