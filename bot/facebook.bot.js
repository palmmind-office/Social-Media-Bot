const BootBot = require("bootbot");
const ioClient = require("socket.io-client");
const bodyParser = require("body-parser");
const { patchMessage } = require("../utils");
const fetch = require("node-fetch");

class CustomBootBot extends BootBot {
  constructor(config, type = "fb") {
    if (!config.accessToken || !config.verifyToken || !config.appSecret) {
      console.log("missing app credentials", type);
      config = { accessToken: "_____", verifyToken: "______", appSecret: "______" };
    }
    super(config);
    this.webhook = "/webhooks/" + type;
    this.type = type;
    this._botClientUrl =
      process.env.BOT_SOCKET_URL ||
      `${process.env.SOCKET_PROTOCOL}://${process.env.SOCKET_HOST}:${process.env.SOCKET_PORT}`;
    this._sockets = {};
  }

  connectSocket(userId) {
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
        newSocket.emit("user:join", userId, "all", "User", this.type, {}, onUserJoin.bind(this));
      });
    });
  }

  start(app) {
    init(app, this);
  }

  _formatQuickReplies(quickReplies) {
    return (
      quickReplies &&
      quickReplies.map((reply) => {
        if (typeof reply === "string") {
          return {
            content_type: "text",
            title: reply,
            payload: reply,
          };
        } else if (reply && reply.title) {
          return Object.assign(
            {
              content_type: "text",
              payload: reply.payload || reply,
            },
            reply
          );
        }
        return reply;
      })
    );
  }

  async getUserProfile(userId) {
    const fields =
      this.type === "fb" ? "first_name,last_name,profile_pic,locale,timezone,gender" : "username,name,profile_pic";
    const url = `https://graph.facebook.com/${this.graphApiVersion}/${userId}?fields=${fields}&access_token=${this.accessToken}`;
    try {
      const res = await fetch(url);
      return await res.json();
    } catch (err) {
      return console.log(`Error getting user profile: ${err}`);
    }
  }

  async handleResponseMessage(metadata, message) {
    const userId = metadata.receipent
    const senderId = metadata.sender
    const options = this.type === "fb" ? { typing: true } : null;
    message = message.custom ? (Array.isArray(message.custom) ? message.custom[0] : message.custom) : message;
    if (message.buttons && (this.type !== "fb" || message.buttons.length > 3)) {
      message.quickReplies = message.buttons.map((x) => ({ title: x.title, payload: x.payload }));
      delete message.buttons;
    } else if (message.buttons) {
      message.buttons.forEach((button) => (button.type = button.type || "postback"));
    }
    const displayMessage =
      message.quickReplies || message.buttons ? message : message.text || message.description || message || "No response";
    message.metadata = { senderId };
    await this.say(userId, displayMessage, options);
    if (message.attachment?.payload) {
      await this.sendAttachment(userId, message.attachment.type, message.attachment.payload)
    }
    if (!message.elements) {
      return null;
    }
    message.elements.forEach((element) => {
      element.buttons.forEach((button) => {
        button.type = button.type || "postback";
      });
    });
    const noOfTens = Math.ceil(message.elements.length / 10);
    for (let i = 0; i < noOfTens; i++) {
      await this.sendGenericTemplate(userId, message.elements.slice(i, 10), options);
    }
  }
}

exports.messengerBot = new CustomBootBot(
  {
    accessToken: process.env.MESSENGER_ACCESS_TOKEN,
    verifyToken: process.env.MESSENGER_VERIFY_TOKEN,
    appSecret: process.env.MESSENGER_APP_SECRET,
  },
  "fb"
);

exports.instagramBot = new CustomBootBot(
  {
    accessToken: process.env.INSTAGRAM_ACCESS_TOKEN,
    verifyToken: process.env.INSTAGRAM_VERIFY_TOKEN,
    appSecret: process.env.INSTAGRAM_APP_SECRET,
  },
  "instagram"
);

function init(app, bot) {
  const humanMessages = ["human", "agent", "support"];
  const persistentMenuButtons = [
    {
      type: "postback",
      title: "Menu (End Live Chat)",
      payload: "menu",
    },
    {
      type: "postback",
      title: "Talk to Live Agent",
      payload: "talk_to_live_agent",
    },
  ];
  const greetingMessage = process.env.SET_GREETING_MESSAGE_FACEBOOK || 'Warm welcome to CG Digital I am Elex- Your Virtual Assistant. I am here to help you with your queries related to CG Digital.'
  bot.setGetStartedButton("Get Started");
  bot.setGreetingText(greetingMessage)
  bot.setPersistentMenu(persistentMenuButtons);

  app.use(bot.webhook, bodyParser.json({ verify: bot._verifyRequestSignature.bind(bot) }));

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
      entry.messaging.forEach((event) => preHandleFunction(event, `${bot.type} bot`));
    });
    bot.handleFacebookData(req.body);
    res.status(200).end();
  });

  bot.on("message", async (payload, chat) => {
    const { text: title, mid, quick_reply } = payload.message;
    const { userId } = chat;
    const isConnected = await bot.connectSocket(userId);

    if (!isConnected) {
      return null;
    }
    // to handle reaction messages no response to be shown in messenger or instagram interface
    // if (!mid) {
    //   // console.log("FBBOT 80", title);
    //   postMessage(title, {}, , "incoming", "human");
    //   return null;
    // }

    const message = {
      title,
      payload: humanMessages.includes(title.toLowerCase()) ? "human" : (quick_reply && quick_reply.payload) || title,
    };

    const metadata = { mid };

    if (message.payload === "human") {
      bot._sockets[userId]?.emit("livechat:request");
    };

    bot._sockets[userId]?.emit("message:sent", message, metadata);
  });

  bot.on("attachment", async (payload, chat) => {
    const { userId } = chat;
    const isConnected = await bot.connectSocket(userId);
    if (!isConnected) {
      return null;
    }

    payload.message.attachments.forEach((attachment) => {
      const message = {
        title: '',
        payload: "/attachments",
        attachment: {
          type: attachment.type,
          payload: attachment.payload.url
        }
      };
      const metadata = {
        mid: payload.message.mid,
      };

      bot._sockets[userId]?.emit("message:sent", message, metadata);
    });
  });

  bot.on("postback", async (payload, chat) => {
    const { userId } = chat;
    const isConnected = await bot.connectSocket(userId);
    if (!isConnected) {
      return null;
    }

    const { mid } = payload.postback;

    const message = {
      title: payload.postback.title,
      payload: payload.postback.payload,
    };
    const metadata = { mid };
    if (message.payload === "human") {
      bot._sockets[userId]?.emit("livechat:request");
    }
    bot._sockets[userId]?.emit("message:sent", message, metadata);
  });
}

function preHandleFunction(event, bot) {
  const repliedId = event.message?.reply_to;
  let query = event.message ? event.message.text : "";
  if (event.reaction) {
    event.message = {
      text: `Reaction: ${event.reaction.emoji || "unreact"}`,
      payload: `/reaction::${event.reaction.mid}`
    };
    query = "reaction";
  }
  if (repliedId && repliedId.story) {
    event.message.text = `Story Reply: ${event.message.text || "AVATAR"}`;
    event.message.payload = '/reply_story'
  } else if (repliedId) {
    event.message.payload = "/reply_message";
    query = "message reply";
  }
  const isDeleted = event.message?.is_deleted;
  if (isDeleted) {
    patchMessage(event.message, "this message was unsent").then(() => {
      event.message.mid = null;
    });
    return null;
  }

  if (event.postback) {
    query = event.postback.title;
  }

  if (!event.message && !event.postback) {
    return null;
  }

  if (event.message && event.message.attachments) {
    query = "attachments";
  } else if (event.message && event.message.is_unsupported) {
    event.message.text = "Unsupported (possibly multiple attachments)";
    event.message.payload = "/unsupported"
    query = "unsupported";
  }
}

exports.interveneRasa = function (utter) {
  const payload = utter.match(/payload=["']\/[a-z_]+["']/);
  if (payload) {
    utter = payload[0].split("=")[1];
  }
  utter = utter.replaceAll(/[\/"']/g, "");
  const responses = {
    reply_story: {
      text: "Thank you for replying to our story. You can talk to live agent if you have any query.",
      buttons: [{ title: "Live Agent", payload: "livechat:request" }],
    },
    attachments: {
      text: "I am not able to understand images, audio or video. Would you like to talk to live agent?",
      buttons: [{ title: "Live Agent", payload: "livechat:request" }],
    },
    reply_message: {
      text: "Thank you for replying to our message. You can talk to live agent if you have any query.",
      buttons: [{ title: "Live Agent", payload: "livechat:request" }],
    },
    unsupported: {
      text: "I am not able to understand images, audio or video. Would you like to talk to live agent?",
      buttons: [{ title: "Live Agent", payload: "livechat:request" }],
    },
  };
  if (Object.keys(responses).includes(utter)) {
    return responses[utter];
  }
  return null;
};
