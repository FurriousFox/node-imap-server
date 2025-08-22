import IMAPServer from "./index.ts";
import crypto from "node:crypto";

new IMAPServer({
    port: 1433,
}, {
    connection(event, action) {
        console.log(`received connection from ${event.connection.source.address}`);

        // action.noAuth();
        action.requireLogin();
    },

    auth(event, action) {
        if (crypto.hash("sha512", Buffer.concat([
            Buffer.from(event.username),
            Buffer.from("+e4963616-97cc-420f-acaf-03ecc19abf9b+"),
            Buffer.from(event.password),
        ])) == "8c8ab6e002eea2d03254cb4b66a906164295b9d8cb7ba433196d4d4c1246850277435883e4e1a23fdb68cef1b1796c0a856864a0f1e16c080d5b78b170a2ebe7") action.accept();
        else action.reject();
    },
});