const { EventEmitter } = require("node:events");
const crypto = require("crypto")
const ioClient = require("socket.io-client");

const bodyParser = require("body-parser");
const fetch = require("node-fetch");


class WhatsappBot extends EventEmitter {
    constructor(config, type = "whatsapp") {
        super();
        if (!config.accessToken || !config.verifyToken || !config.fromId || !config.appSecret) {
            console.log("missing app credentials", type);
            config = { accessToken: "_____", verifyToken: "______", fromId: "______", appSecret: "________" };
        }
        this.webhook = "/webhooks/" + type;
        this.type = type;
        this._botClientUrl =
            process.env.BOT_SOCKET_URL ||
            `${process.env.SOCKET_PROTOCOL}://${process.env.SOCKET_HOST}:${process.env.SOCKET_PORT}`;
        this._sockets = {};
        this.verifyToken = config.verifyToken;
        this.accessToken = config.accessToken;
        this.fromId = config.fromId;
        this.appSecret = config.appSecret;
        this.graphApiVersion = config.graphApiVersion || '17.0';
    }

    start(app) {
        init(app, this);
    }

    connectSocket(userId, name, mobileNumber) {
        return new Promise((resolve, _) => {
            if (this._sockets[userId] && this._sockets[userId].io?.readyState === 'open') {
                return resolve(true);
            }

            this._sockets[userId] && this._sockets[userId].disconnect();
            const newSocket = ioClient(this._botClientUrl, {
                query: {
                    token: process.env.SOCKET_TOKEN,
                },
                forceNew: true,
            });

            function onUserJoin(value) {
                if (!value) {
                    return resolve(value)
                }
                newSocket.on("message:received", async (message, metadata) => {
                    const responseMessage = Array.isArray(message) ? message : [message];
                    for (let i = 0; i < responseMessage.length; i++) {
                        try {
                            await this.handleResponseMessage(metadata, responseMessage[i]);
                        } catch (error) {
                            console.log("couldn't send this message => ", responseMessage[i]);
                        }
                    }
                });
                this._sockets[userId] = newSocket;
                return resolve(value)
            }

            newSocket.on("connect", () => {
                newSocket?.emit("user:join", userId, "all", "User", this.type, { name, mobileNumber }, onUserJoin.bind(this));
            });
        });
    }

    async handleResponseMessage(metadata, message) {
        const userId = metadata.receipent
        if (message.text && message.buttons) {
            const payloadTitleMap = {};
            const replyText = message['replyText'] || message.text
            for (let button of message.buttons) {
                payloadTitleMap[button.payload] = button.title;
            }
            await this.sendReplyButtons(userId, replyText, { ...payloadTitleMap });
        }
        if (message.attachment?.payload) {
            message.custom = {
                type: 'media',
                fileType: message.attachment?.type,
                url: message.attachment?.payload,
                caption: message.text
            }
        }
        if (message.text && !message.attachment?.payload && !message.buttons) {
            await this.sendText(userId, message.text);
        }
        if (!message.custom) {
            return null;
        }
        const custom = message.custom;
        if (custom.hasOwnProperty('text') || custom.hasOwnProperty('message')) {
            return await this.sendText(userId, custom.text || custom.message);
        }
        switch (custom.type) {
            case 'image':
                const { imageUrl, caption } = custom
                await this.sendMedia(userId, "image", { link: imageUrl, caption: caption });
                break;
            case 'media':
                const { fileType, url, caption: fileCaption } = custom;
                const type = fileType === 'file' ? 'document' : fileType;
                const data = { link: url, caption: fileCaption };
                if (type === 'document') {
                    data.filename = url.split("/").at(-1).split("-").at(-1)
                }
                await this.sendMedia(userId, type, data);
                break;
            case 'text':
                await this.sendText(userId, custom.text || custom.message);
                break
            case 'list':
                let { buttonName, bodyText, sections, options } = custom
                await this.sendList(userId, buttonName, bodyText, sections, { ...options });
                break;
            case 'quickReplyButttons':
                let { replyText, buttons } = custom
                await this.sendReplyButtons(userId, replyText, { ...buttons })
                break
            case 'location':
                await this.sendLocation(userId, custom)
                break
            default:
                console.log(`Unknown type ${custom["type"]}`);
        }
    }

    async #sendRequest(body, endpoint, method) {
        endpoint = endpoint || `${this.fromId}/messages`;
        method = method || 'POST';
        try {
            const url = `https://graph.facebook.com/v${this.graphApiVersion}/${endpoint}`;
            const headers = {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.accessToken}`
            };
            const res = await fetch(url, {
                method, headers, body: body ? JSON.stringify(body) : undefined
            });
            const data = await res.json();
            if (data.error) {
                console.log('Whatsapp Error received. For more information about error codes, see: https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes');
                console.log(data.error);
            }
            return data;
        } catch (err) {
            return console.log(`Error sending message: ${err}`);
        }
    }

    async downloadMedia(mediaId) {
        try {
            const data = await this.#sendRequest(undefined, mediaId, "GET");
            if (!data?.url) {
                return null;
            }
            return fetch(data.url, {
                method: 'GET',
                headers: { 'Authorization': `Bearer ${this.accessToken}` }
            })
        } catch (error) {
            console.log("ERROR IN GET MEDIA URL (WHATSAPP) => ", error);
            return ""
        }
    }

    async sendGenericMessage(toPhoneNumber, type, data) {
        return this.#sendRequest({
            messaging_product: "whatsapp",
            recipient_type: "individual",
            to: toPhoneNumber,
            type,
            [type]: data
        })
    }

    async sendText(toPhoneNumber, text, previewUrl = false) {
        return this.sendGenericMessage(toPhoneNumber, "text", {
            preview_url: previewUrl,
            body: text
        })
    }

    async sendMedia(toPhoneNumber, type, data) {
        return this.sendGenericMessage(toPhoneNumber, type, data)
    }

    async sendTemplate(toPhoneNumber, name, languageCode, components) {
        return this.sendGenericMessage(toPhoneNumber, "template", {
            name,
            language: {
                code: languageCode,
            },
            components,

        })
    }

    async sendInteractive(toPhoneNumber, bodyText, type, data, options) {
        return this.sendGenericMessage(toPhoneNumber, "interactive", {
            body: { text: bodyText },
            ...(options?.footerText ? { footer: { text: options.footerText } } : {}),
            header: options?.header,
            type,
            action: data
        })
    }

    async sendReplyButtons(toPhoneNumber, bodyText, buttons, options) {
        const data = {
            buttons: Object.entries(buttons).map(([key, value]) => ({
                type: 'reply',
                reply: {
                    title: value,
                    id: key,
                }
            }))
        }
        return this.sendInteractive(toPhoneNumber, bodyText, "button", data, options)
    }

    async sendLocation(toPhoneNumber, LocationData) {
        if (!Object.keys(LocationData).includes('data')) {
            return this.sendGenericMessage(toPhoneNumber, 'location', {
                "latitude": LocationData.latitude,
                "longitude": LocationData.longitude,
                "name": LocationData.name,
                "address": LocationData.address
            })
        }
        LocationData.data.forEach((location) => {
            this.sendGenericMessage(toPhoneNumber, 'location', {
                "latitude": location.latitude,
                "longitude": location.longitude,
                "name": location.name,
                "address": location.address
            })
        })

    }

    async sendList(toPhoneNumber, buttonName, bodyText, sections, options) {
        const data = {
            button: buttonName,
            sections: Object.entries(sections).map(([key, value]) => ({
                title: key,
                rows: value,
            })),
        }
        return this.sendInteractive(toPhoneNumber, bodyText, "list", data, options)
    }
}

function init(app, bot) {
    const humanMessages = ["human", "agent", "support"];

    app.use(bot.webhook, bodyParser.json({
        verify: function (req, res, buf) {
            var signature = req.headers['x-hub-signature'];
            if (!signature) {
                throw new Error('Couldn\'t validate the request signature.');
            } else {
                var elements = signature.split('=');
                var signatureHash = elements[1];
                var expectedHash = crypto.createHmac('sha1', bot.appSecret)
                    .update(buf)
                    .digest('hex');

                if (signatureHash != expectedHash) {
                    throw new Error('Couldn\'t validate the request signature.');
                }
            }
        }
    }));


    app.get(bot.webhook, (req, res) => {
        if (req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === bot.verifyToken) {
            console.log("Validation Succeded.");
            res.status(200).send(req.query["hub.challenge"]);
        } else {
            console.error("Failed validation. Make sure the validation tokens match.");
            res.sendStatus(403);
        }
    });

    app.post(bot.webhook, async (req, res) => {
        req.body.entry.forEach((entry) => {
            entry.changes.forEach((change) => {
                const messages = change.value?.messages || [];
                const contacts = change.value?.contacts || [];
                messages.forEach(message => {
                    const messageType = ['text', 'interactive'].includes(message?.type) ? message.type : 'attachment';
                    const name = contacts[0]?.profile?.name || null;
                    name && (message['name'] = name)
                    bot.emit(messageType, message)
                })
            })
        });
        res.status(200).end();
    });


    bot.on("text", async (payload) => {
        const { from: userId, id: mid, timestamp: time, name = null } = payload;
        await bot.connectSocket(userId, name, userId);

        const title = payload.text?.body || "";
        const message = {
            title: title,
            payload: humanMessages.includes(title.toLowerCase()) ? "human" : title
        };

        const metadata = { mid, time, name, phoneNumber: userId };
        if (message.payload === "human") {
            bot._sockets[userId]?.emit("livechat:request");
        }
        bot._sockets[userId]?.emit("message:sent", message, metadata);
    });

    bot.on("interactive", async (payload) => {
        const { from: userId, id: mid, timestamp: time, name = null } = payload;
        await bot.connectSocket(userId, name, userId);

        const interactiveType = payload.interactive?.type || "button_reply";

        const { id: messagePayload, title } = payload.interactive[interactiveType] || {};

        const message = { title, payload: messagePayload };

        // const metadata = { mid, time }
        const metadata = { mid, time, name, phoneNumber: userId };
        bot._sockets[userId]?.emit("message:sent", message, metadata);
    });

    // bot.ioClient.on("connect", ()=>{
    //     bot.ioClient.emit("user:join", bot.type.toUpperCase());
    // })

    bot.on("attachment", async (payload) => {
        const { from: userId, id: mid, timestamp: time, type, name = null } = payload;
        await bot.connectSocket(userId, name, userId);

        const metadata = { mid, time, name, phoneNumber: userId };

        if (type === 'unsupported') {
            bot._sockets[userId]?.emit("message:sent", { title: "Unsupported Attachment" })
        }
        const extension = payload[type]?.mime_type?.split("/").at(-1);
        const message = {
            title: payload[type]?.caption || "",
            payload: '/attachments',
            attachment: {
                type: type === 'sticker' ? 'image' : type,
                payload: `${process.env.FILE_BASE_URL}rest/v1/chat/whatsappFile/${payload[type]?.id}.${extension}`
            }
        }
        bot._sockets[userId]?.emit("message:sent", message, metadata);
    });
}


module.exports = new WhatsappBot({
    fromId: process.env.WHATSAPP_FROM_ID,
    accessToken: process.env.WHATSAPP_ACCESS_TOKEN,
    verifyToken: process.env.WHATSAPP_VERIFY_TOKEN,
    appSecret: process.env.WHATSAPP_APP_SECRET
});
