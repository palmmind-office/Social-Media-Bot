
const express = require("express");
const dotenv = require("dotenv");

dotenv.config();

const { messengerBot, instagramBot } = require("./bot/facebook.bot");

const whatsappBot = require("./bot/whatsapp.bot");
const viberBot = require("./bot/viber.bot");
const fetch = require("node-fetch");

const PORT = 6200;
const app = new express();

messengerBot.start(app);
//instagramBot.start(app);
//whatsappBot.start(app);
//viberBot.start(app);

app.get("/status", async function (req, res) {
    res.send("runningy");
});


app.get("/facebook-profile/:userId", async function (req, res) {
    const { userId } = req.params;
    const data = await messengerBot.getUserProfile(userId);
    res.send(data || {});
});

app.get("/instagram-profile/:userId", async function (req, res) {
    const { userId } = req.params;
    const data = await instagramBot.getUserProfile(userId);
    res.send(data || {});
});

app.use(express.json());

//used by cg
app.post("/post/whatsapp/message", async function (req, res) {
    console.log(req,"req body data")
    let _this=req.body
    let endpoint = _this.endpoint || `${_this.fromId}/messages`;
    let method = _this.method || 'POST';
    try {
        const url = `https://graph.facebook.com/v${_this.graphApiVersion}/${endpoint}`;
        const headers = {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${_this.accessToken}`
        };
        const rest = await fetch(url, {
            method, headers, body: _this.body ? JSON.stringify(_this.body) : undefined
        });
        const data = await rest.json();
        if (data.error) {
            console.log(data)
            console.log('Whatsapp Error received. For more information about error codes, see: https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes');
            return  res.status(500).send({status: 500,error:true});
        }
        return res.status(200).send(data);;
    } catch (err) {
        res.status(500).send({status: 500,error:true});
        return console.log(`Error sending message: ${err}`);
    }
});

app.use((_, res) => { res.status(404).send("Not Found") });

app.use((_1, _2, res) => { res.status(500).send("ERROR") });

app.listen(PORT, () => {
    console.log("Separate Fb Bot Server listening on ", PORT);
})
