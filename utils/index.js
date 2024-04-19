const fetch = require("node-fetch");

async function patchMessage(message, text = "unsent message") {
    const host = process.env.DASHBOARD_SERVER;
    const port = process.env.DASHBOARD_PORT;
    const protocol = "http://";
    const path = "/rest/v1/messages?access_token=" + process.env.ADMIN_TOKEN;
    const baseUrl = protocol + host + ":" + port + path;

    const headers = {
        "Content-Type": "application/json",
    };

    try {
        const filter = { where: { "metadata.mid": message.mid } };
        const fullUrl = baseUrl + `&${new URLSearchParams({ filter: JSON.stringify(filter) }).toString()}`;
        const getResponse = await fetch(fullUrl, { method: "GET", headers });
        const { data: getData } = await getResponse.json();

        if (!getData.length) {
            throw new Error("message to be patched was not found");
        };

        const patchBody = { id: getData[0].id, text };
        return fetch(baseUrl, { method: "PATCH", headers, body: JSON.stringify(patchBody) });
    } catch (err) {
        console.log("Please verify your dashboard server is running or not", err);
    }
}

module.exports = { patchMessage }