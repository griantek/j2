import express from 'express';
import fetch from 'node-fetch';
import 'dotenv/config';

const app = express();
const port = process.env.PORT || 3002;

// Parse JSON bodies
app.use(express.json());

// Your Elsevier API key should be stored in environment variables
const ELSEVIER_API_KEY = process.env.ELSEVIER_API_KEY;

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

// Handle incoming messages
app.post('/webhook', async (req, res) => {
    try {
        const { entry } = req.body;

        if (entry && entry[0].changes && entry[0].changes[0].value.messages) {
            const message = entry[0].changes[0].value.messages[0];
            const from = message.from;
            const messageText = message.text.body;

            // Search for journals and send response
            await handleJournalSearch(from, messageText);
        }

        res.sendStatus(200);
    } catch (error) {
        console.error('Error processing webhook:', error);
        res.sendStatus(500);
    }
});

// Function to search journals
async function searchJournals(title) {
    const url = "https://api.elsevier.com/content/serial/title";
    const params = new URLSearchParams({
        title: title,
        apiKey: ELSEVIER_API_KEY,
        view: "STANDARD"
    });

    try {
        const response = await fetch(`${url}?${params}`, {
            headers: { "Accept": "application/json" }
        });

        if (!response.ok) {
            throw new Error(`API Error: ${response.status}`);
        }

        const data = await response.json();
        const journals = data["serial-metadata-response"].entry;
        
        return journals
            .map(journal => ({
                title: journal["dc:title"] || "N/A",
                citeScore: journal.citeScoreYearInfoList?.citeScoreCurrentMetric || "N/A",
                scopusLink: journal.link.find(link => link["@ref"] === "scopus-source")?.["@href"] || "N/A"
            }))
            .sort((a, b) => {
                if (a.citeScore === "N/A") return 1;
                if (b.citeScore === "N/A") return -1;
                return b.citeScore - a.citeScore;
            })
            .slice(0, 20); // Limit to 20 entries
    } catch (error) {
        console.error('Error searching journals:', error);
        throw error;
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

// Handle journal search and send response
async function handleJournalSearch(userPhoneNumber, searchTitle) {
    try {
        const journals = await searchJournals(searchTitle);
        
        if (journals.length === 0) {
            await sendWhatsAppMessage(
                userPhoneNumber, 
                "No journals found matching your search criteria."
            );
            return;
        }

        // Format response message
        let responseMessage = `Top ${journals.length} journals matching "${searchTitle}":\n\n`;
        journals.forEach((journal, index) => {
            responseMessage += `${index + 1}. ${journal.title}\n`;
            responseMessage += `   CiteScore: ${journal.citeScore}\n`;
            responseMessage += `   Scopus: ${journal.scopusLink}\n\n`;
        });

        // Send response in chunks if too long
        const MAX_MESSAGE_LENGTH = 4096;
        for (let i = 0; i < responseMessage.length; i += MAX_MESSAGE_LENGTH) {
            const chunk = responseMessage.slice(i, i + MAX_MESSAGE_LENGTH);
            await sendWhatsAppMessage(userPhoneNumber, chunk);
        }
    } catch (error) {
        await sendWhatsAppMessage(
            userPhoneNumber,
            "Sorry, there was an error processing your request. Please try again later."
        );
    }
}

app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});