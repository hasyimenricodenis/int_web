const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const fs = require('fs');
const Tesseract = require('tesseract.js');
const readline = require('readline');
const xlsx = require('xlsx'); // Import xlsx library
const path = require('path');

const app = express();
const PORT = 3000;

app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public'))); // Serve static files from 'public' directory

const deleteAllCaptchaFiles = async () => {
    return new Promise((resolve, reject) => {
        fs.readdir('./', (err, files) => {
            if (err) {
                return reject(err);
            }
            const captchaFiles = files.filter(file => file.startsWith('captcha_') && file.endsWith('.png'));
            Promise.all(captchaFiles.map(file => fs.promises.unlink(file))).then(resolve).catch(reject);
        });
    });
};

// Function to download and save the captcha image
const downloadCaptcha = async (url, filepath) => {
    const response = await axios({
        method: 'get',
        url: url,
        responseType: 'stream',
    });
    return new Promise((resolve, reject) => {
        response.data.pipe(fs.createWriteStream(filepath))
            .on('finish', resolve)
            .on('error', reject);
    });
};

// Function to read captcha image using Tesseract OCR with configuration
const readCaptcha = async (filepath) => {
    return new Promise((resolve, reject) => {
        Tesseract.recognize(filepath, 'eng', {
            tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', // Allow only capital letters and digits
        })
            .then(result => resolve(result.data.text.trim())) // Extract the text
            .catch(err => reject(err));
    });
};

// Function to delete the captcha image after successful captcha resolution
const deleteCaptchaFile = async (filepath) => {
    return new Promise((resolve, reject) => {
        fs.unlink(filepath, (err) => {
            if (err) {
                reject(err);
            } else {
                resolve();
            }
        });
    });
};

// Function to send the request and retry if the captcha is invalid
const sendRequest = async (item) => {
    let retry = true;
    let status = "";
    let mapping;

    while (retry) {
        let data = 'action=post-tracking&referenceNumber=' + item;

        const config = {
            method: 'post',
            maxBodyLength: Infinity,
            url: 'https://brifast.co.id/wp-admin/admin-ajax.php',
            headers: {
                // Your headers here
            },
            data: data,
        };
        try {
            let response = await axios.request(config);
            const responseData = response.data;

            if (responseData.responDesc === 'Invalid captcha.') {
                const captchaUrl = responseData.comment_captcha_image_src;
                const captchaPrefix = responseData.comment_captcha_prefix;
                const captchaImagePath = `./captcha_${captchaPrefix}.png`;

                // Download the captcha image
                await downloadCaptcha(captchaUrl, captchaImagePath);

                // Read the captcha using OCR
                const captchaText = await readCaptcha(captchaImagePath);

                // Resend the request with the captcha text
                data = `action=post-tracking&referenceNumber=${item}&comment_captcha_code=${captchaText}&comment_captcha_prefix=${captchaPrefix}&visit_page=0`;
                const updatedConfig = { ...config, data: data }; // Avoid mutating original config

                response = await axios.request(updatedConfig);
                const desc = response.data.responDesc.toLowerCase();
                const bankName = response.data.bankCode;

                switch (true) {
                    case desc.includes('not found'):
                        mapping = 'The transaction is not found in our system and is not debited from your account. You may cancel the transaction.';
                        break;
                    case desc.includes('cair'):
                        mapping = 'This is a cash pick-up transaction, and it is ready to be collected by the beneficiary. Please advise the beneficiary to visit the nearest BRI Branch Office. If the beneficiary has any difficulty collecting the funds, please contact us for assistance.';
                        break;
                    case desc.includes('gagal'):
                        mapping = `The beneficiary bank (${bankName}) is in severe disturbance. Transaction is not debited from your account. You may cancel the transaction.`;
                        break;
                    case desc.includes('pending'):
                        mapping = 'The transaction is still in process to be credited to the beneficiary.';
                        break;
                    case desc.includes('sukses'):
                        mapping = 'This transaction is successful and the amount has been debited from your account.';
                        break;
                    case desc.includes('proses'):
                        mapping = 'The transaction is still in process to be credited to the beneficiary.';
                        break;
                    default:
                        mapping = '';
                        break;
                }

                if (response.data.responDesc !== 'Invalid captcha.') {
                    status = response.data.responDesc;
                    retry = false; // Break the loop if captcha is valid
                    await deleteCaptchaFile(captchaImagePath);
                }
            } else {
                status = responseData.responDesc;
                retry = false; // Break the loop if captcha is not involved
            }

        } catch (error) {
            status = "Error: " + error.message;
            retry = false; // Exit the loop on error
        }
    }

    return { refNumber: item, status, mapping };
};

// Route to handle submission
app.post('/submit', async (req, res) => {
    const { refNumber } = req.body;

    if (!refNumber) {
        return res.status(400).json({ error: 'Reference number is required' });
    }

    try {
        const result = await sendRequest(refNumber);
        await deleteAllCaptchaFiles();
        res.json(result);
    } catch (error) {
        console.error('Error processing request:', error);
        res.status(500).json({ error: 'An error occurred while processing the request' });
    }
});

// Start the server
app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
