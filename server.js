import express from 'express';
import sqlite3 from 'sqlite3';
const { Database } = sqlite3;
import fetch from 'node-fetch';
import 'dotenv/config';

const app = express();
const port = process.env.PORT || 3002;

// Parse JSON bodies
app.use(express.json());

// Your API tokens should be stored in environment variables
const ELSEVIER_API_KEY = process.env.ELSEVIER_API_KEY || "718bcc88d9301d08994dfaded3291e39";

// Verify webhook
app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode && token) {
        if (mode === 'subscribe' && token === process.env.VERIFY_TOKEN) {
            console.log('Webhook verified');
            res.status(200).send(challenge);
        } else {
            res.sendStatus(403);
        }
    }
});

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

    const matchesAllKeywords = (title, kwList) => {
        const lowerTitle = title.toLowerCase();
        return kwList.every(kw => lowerTitle.includes(kw));
    };

    for (let size = normalizedKeywords.length; size > 0; size--) {
        for (const subset of combinations(normalizedKeywords, size)) {
            const matchedTitles = titles.filter(title => matchesAllKeywords(title, subset));

            matchedTitles.forEach(title => {
                if (!seen.has(title)) {
                    results.push(title);
                    seen.add(title);
                }
            });

            if (results.length > 0) break;
        }

        if (results.length > 0) break;
    }

    return results;
}

// Function to fetch journal data from Elsevier API
async function fetchJournalData(title) {
    const params = new URLSearchParams({
        title: title,
        apiKey: ELSEVIER_API_KEY,
        view: "STANDARD"
    });

    try {
        const response = await fetch(`https://api.elsevier.com/content/serial/title?${params}`, {
            headers: { "Accept": "application/json" }
        });

        if (response.ok) {
            const data = await response.json();
            const journals = data["serial-metadata-response"].entry;
            if (!journals || journals.length === 0) return null;

            const journal = journals[0];
            const title = journal["dc:title"] || "N/A";
            let citeScore = "N/A";
            const citeScoreYearInfo = journal["citeScoreYearInfoList"];
            if (citeScoreYearInfo && citeScoreYearInfo["citeScoreCurrentMetric"]) {
                citeScore = parseFloat(citeScoreYearInfo["citeScoreCurrentMetric"]);
            }

            const sourceLink = journal.link.find(link => link["@ref"] === "scopus-source");
            const scopusLink = sourceLink ? sourceLink["@href"] : "N/A";

            return { title, citeScore, scopusLink };
        }
        return null;
    } catch (error) {
        console.error("Error fetching journal data:", error);
        return null;
    }
}

// Function to send WhatsApp message
async function sendWhatsAppMessage(to, message) {
    try {
        const response = await fetch(`${process.env.WHATSAPP_API_URL}`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                messaging_product: "whatsapp",
                to: to,
                type: "text",
                text: { body: message }
            })
        });

        if (!response.ok) {
            throw new Error(`WhatsApp API Error: ${response.status}`);
        }
    } catch (error) {
        console.error('Error sending WhatsApp message:', error);
        throw error;
    }
}

// Handle incoming messages
app.post('/webhook', async (req, res) => {
    try {
        const { entry } = req.body;

        if (entry && entry[0].changes && entry[0].changes[0].value.messages) {
            const message = entry[0].changes[0].value.messages[0];
            const from = message.from;
            const searchKeywords = message.text.body.split(' ');

            await handleJournalSearch(from, searchKeywords);
        }

        res.sendStatus(200);
    } catch (error) {
        console.error('Error processing webhook:', error);
        res.sendStatus(500);
    }
});

// Handle journal search and send response
async function handleJournalSearch(userPhoneNumber, searchKeywords) {
    try {
        // Send initial message
        await sendWhatsAppMessage(userPhoneNumber, "Searching for journals matching your keywords...");

        // Fetch titles from database
        const titles = await fetchTitlesFromDatabase();
        const matchedTitles = searchTitles(titles, searchKeywords);

        if (matchedTitles.length === 0) {
            await sendWhatsAppMessage(userPhoneNumber, "No matching journals found for your keywords.");
            return;
        }

        // Fetch journal data for matched titles
        const journalData = [];
        for (const title of matchedTitles) {
            const journal = await fetchJournalData(title);
            if (journal) {
                journalData.push(journal);
            }
        }

        // Sort and get top 10
        const top10Journals = journalData
            .sort((a, b) => {
                if (a.citeScore === "N/A") return 1;
                if (b.citeScore === "N/A") return -1;
                return b.citeScore - a.citeScore;
            })
            .slice(0, 10);

        if (top10Journals.length === 0) {
            await sendWhatsAppMessage(userPhoneNumber, "No journal data available for the matched titles.");
            return;
        }

        // Format and send results
        let responseMessage = `Top ${top10Journals.length} Journals matching your search:\n\n`;
        top10Journals.forEach((journal, index) => {
            responseMessage += `${index + 1}. ${journal.title}\n`;
            responseMessage += `   CiteScore: ${journal.citeScore}\n`;
            responseMessage += `   Link: ${journal.scopusLink}\n\n`;
        });

        // Send response in chunks if needed
        const MAX_MESSAGE_LENGTH = 4096;
        for (let i = 0; i < responseMessage.length; i += MAX_MESSAGE_LENGTH) {
            const chunk = responseMessage.slice(i, i + MAX_MESSAGE_LENGTH);
            await sendWhatsAppMessage(userPhoneNumber, chunk);
        }
    } catch (error) {
        console.error('Error in handleJournalSearch:', error);
        await sendWhatsAppMessage(
            userPhoneNumber,
            "Sorry, there was an error processing your request. Please try again later."
        );
    }
}

app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});