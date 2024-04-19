const { EventEmitter } = require("node:events");
const ioClient = require("socket.io-client");

const fetch = require("node-fetch");


class ViberBot extends EventEmitter {
    constructor(config, type = "viber") {
        super();
        if (!config.accessToken || !config.senderName) {
            console.log("missing app credentials", type);
            config = { accessToken: "_____", senderName: "______" };
        }
        this.webhook = "/webhooks/" + type;
        this.type = type;
        this._botClientUrl =
            process.env.BOT_SOCKET_URL ||
            `${process.env.SOCKET_PROTOCOL}://${process.env.SOCKET_HOST}:${process.env.SOCKET_PORT}`;
        this._sockets = {};
        this.accessToken = config.accessToken;
        this.sender = {
            name: config.senderName,
        }
        if (config.senderAvatar) {
            this.sender.avatar = config.senderAvatar;
        }
    }

    start(app) {
        init(app, this);
        this.setWebhooks();
    }

    connectSocket(userId, name) {
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
                    return resolve(value);
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
                newSocket.emit("user:join", userId, "all", "User", this.type, { name }, onUserJoin.bind(this));
            });
        });
    }

    async handleResponseMessage(metadata, message) {
        const userId = metadata.receipent.replaceAll('!$', '+')
        if (message.text && message.buttons) {
            await this.sendReplyButtons(userId, message.text, message.buttons)
        }
        if (message.attachment?.payload) {
            message.custom = {
                type: 'media',
                fileType: message.attachment?.type,
                media: message.attachment?.payload,
                size: metadata.size
            }
            if (message.text) {
                message.custom.caption = message.text
            }
        }
        if (message.text && !message.attachment?.payload && !message.buttons) {
            await this.sendText(userId, message.text);
        }
        if (!message.custom) {
            return null;
        }
        const custom = message.custom;
        if (custom.text || custom.message) {
            return await this.sendText(userId, custom.text || custom.message);
        }

        const customType = custom.type || custom.Type;
        switch (customType) {
            case 'image':
                const { imageUrl, caption } = custom
                await this.sendMedia(userId, "picture", { media: imageUrl, text: caption });
                break;
            case 'media':
                const { fileType, media, caption: text, size } = custom;
                const type = fileType === 'image' ? 'picture' : fileType;
                const data = { media, text }
                if (type !== 'picture') {
                    data.size = size;
                }
                if (type === 'file') {
                    data.file_name = media.split("/").at(-1).split("-").at(-1)
                }
                await this.sendMedia(userId, type, data);
                break;
            case 'text':
                await this.sendText(userId, custom.text || custom.message);
                break
            case 'quickReplyButttons':
                const { replyText, buttons } = custom
                await this.sendReplyButtons(userId, replyText, buttons)
                break
            case 'location':
                await this.sendLocation(userId, custom)
                break
            case 'keyboard':
                await this.sendKeyboard(userId, custom);
                break;
            default:
                await this.sendRichMedia(userId, custom)
        }
    }

    async #sendRequest(body, endpoint, method) {
        endpoint = endpoint || 'send_message';
        method = method || 'POST';
        try {
            const url = `https://chatapi.viber.com/pa/${endpoint}`;
            const headers = {
                'Content-Type': 'application/json',
                'X-Viber-Auth-Token': this.accessToken
            };
            const res = await fetch(url, {
                method, headers, body: body ? JSON.stringify(body) : undefined
            });
            const data = await res.json();
            if (data.status) {
                console.log('Viber Error received. For more information about error codes, see: https://developers.viber.com/docs/api/rest-bot-api/');
                console.log(`${data.status}: ${data.status_message}`);
            }
            return data;
        } catch (err) {
            return console.log(`Error sending message: ${err}`);
        }
    }

    async setWebhooks() {
        return this.#sendRequest({
            url: `${this._botClientUrl}${this.webhook}`
        }, 'set_webhook')
    }

    async sendGenericMessage(userId, data, sender = this.sender) {
        return this.#sendRequest({
            receiver: userId,
            sender,
            min_api_version: 2,
            ...data
        });
    }
    async sendText(userId, text) {
        return this.sendGenericMessage(userId, { type: "text", text })
    }

    async sendTextWithKeyboard(userId, text, keyboard) {
        return this.sendGenericMessage(userId, { type: "text", text, keyboard })
    }

    async sendMedia(userId, type, data) {
        if (type === 'file') {
            this.sendText(userId, data.text);
            delete data.text;
        }
        return this.sendGenericMessage(userId, { type, ...data })
    }

    async sendKeyboard(userId, data) {
        return this.sendGenericMessage(userId, { keyboard: data });
    }

    async sendRichMedia(userId, rich_media) {
        return this.sendGenericMessage(userId, { type: "rich_media", rich_media })
    }

    async sendLocation(userId, data) {
        await this.sendGenericMessage(userId, { type: "location", location: data })
    }

    async sendReplyButtons(userId, bodyText, buttons) {
        const keyboard = {
            Type: "keyboard",
            Buttons: buttons.map(buttonData => (
                {
                    ...(buttonData.image ? { Columns: 2, Rows: 2 } : {}),
                    Text: `<br><font color=${buttonData.color || "#ffffff"}><b>${buttonData.title}</b></font>`,
                    TextSize: 'large',
                    TextHAlign: 'center',
                    TextVAlign: buttonData.image ? 'bottom' : 'middle',
                    ActionType: 'reply',
                    ActionBody: buttonData.payload,
                    BgColor: '#0171b6',
                    ...(buttonData.image ? { Image: buttonData.image } : {}),
                }
            ))
        }
        return this.sendGenericMessage(userId, { type: "text", text: bodyText, keyboard })
    }
}

function init(app, bot) {
    const humanMessages = ["human", "agent", "support"];

    const messageTypes = {
        text: "text",
        location: "location",
        contact: "contact",
        picture: "attachment",
        sticker: "attachment",
        video: "attachment",
        file: "attachment",
    }

    app.post(bot.webhook, async (req, res) => {
        const eventName = req.body.event;
        if (eventName === "conversation_started" && !req.body.subscribed) {
            let userId = req.body.user.id;
            const text = "Namaste,\nWelcome to CG bot!\nI am *CG-ELEX* _Your Virtual Assistant_ .\nPlease use the quick link below or type the queries you may have."
            const custom = [
                {
                    title: "Our Products",
                    color: "#0171b6",
                    payload: "/product_info",
                    image: "https://demobot.cgelex.com/images/menu/products.png",
                },
                {
                    title: "Product Registration",
                    color: "#0171b6",
                    payload: "/product_registration",
                    image: "https://demobot.cgelex.com/images/menu/registerProduct.png",
                },
                {
                    title: "My Account",
                    color: "#0171b6",
                    payload: "/account_info",
                    image: "https://demobot.cgelex.com/images/menu/myProduct.png",
                },
                {
                    title: "Complaint Registration",
                    color: "#0171b6",
                    payload: "/complaint_feedback",
                    image: "https://demobot.cgelex.com/images/menu/feedback.png",
                },
                {
                    title: "Offers",
                    payload: "/price{{\"price\":\"offer\"}}",
                    color: "#0171b6",
                    image: "https://demobot.cgelex.com/images/menu/faq.png",
                },
                {
                    title: "Contact Us",
                    color: "#0171b6",
                    payload: "/contact",
                    image: "https://demobot.cgelex.com/images/menu/dataCenter.png",
                },
            ];
            return bot.sendReplyButtons(userId, text, custom);
        } else if (eventName !== 'message' || !req.body.sender || !req.body.message) {
            return res.status(200).end();
        }
        const userId = req.body.sender.id
        const messageType = req.body.message.type || 'text';
        const data = {
            mid: req.body.message_token,
            time: req.body.timestamp,
            from: userId.replaceAll('+', '!$'),
            name: req.body.sender.name,
            message: req.body.message[messageType] || req.body.message
        }
        const urlRegex = /^(http(s):\/\/.)[-a-zA-Z0-9@:%._\+~#=]{2,256}\.[a-z]{2,6}\b([-a-zA-Z0-9@:%_\+.,~#?&//=]*)$/g;
        if (urlRegex.test(data.message) === true) {
            return res.status(200).end();
        }
        bot.emit(messageTypes[messageType], data)
        res.status(200).end();
    });

    bot.on("text", async (payload) => {
        const { from: userId, mid, time, name = null } = payload;
        await bot.connectSocket(userId, name);

        const title = payload.message || "";
        const message = {
            title: title,
            payload: humanMessages.includes(title.toLowerCase()) ? "human" : title
        };

        const metadata = { mid, time, name };
        if (message.payload === "human") {
            bot._sockets[userId]?.emit("livechat:request");
        }
        bot._sockets[userId]?.emit("message:sent", message, metadata);
    });

    bot.on("attachment", async (payload) => {
        const { from: userId, id: mid, timestamp: time, name = null } = payload;
        await bot.connectSocket(userId, name);

        const { type, media, file_name, size, text, sticker_id } = payload.message;

        const metadata = { mid, time, size, name };

        const message = {
            title: text,
            payload: '/attachments',
            attachment: {
                type: (type === 'picture' || sticker_id) ? 'image' : type,
                payload: `${media}#file_name-${file_name}`
            }
        }

        bot._sockets[userId]?.emit("message:sent", message, metadata);
    });

    bot.on("location", async (paylaod) => {
        const { from: userId, id: mid, timestamp: time, name = null } = paylaod;
        await bot.connectSocket(userId, name);

        const { lat, lon } = paylaod.message;
        const message = {
            title: `Location: ${lat}, ${lon}`,
            payload: "/user_sent_location",
        }

        const metadata = { mid, time, name }

        bot._sockets[userId]?.emit("message:sent", message, metadata)
    });

    bot.on("contact", async (paylaod) => {
        const { from: userId, id: mid, timestamp: time, name = null } = paylaod;
        await bot.connectSocket(userId, name);

        const { name: contact_name, phone_number } = paylaod.message;
        const message = {
            title: `Contact ${contact_name}: ${phone_number}`,
            payload: "/user_sent_contact",
        }

        const metadata = { mid, time }

        bot._sockets[userId]?.emit("message:sent", message, metadata)
    })
}


module.exports = new ViberBot({
    senderName: process.env.VIBER_SENDER_NAME,
    senderAvatar: process.env.VIBER_SENDER_AVATAR,
    accessToken: process.env.VIBER_PRIVATE_TOKEN,
});
