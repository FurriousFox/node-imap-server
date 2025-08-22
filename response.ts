import net from "node:net";

export interface IMAPSocket extends net.Socket { writeResponse?: (response: IMAPResponse) => void; }

type IMAPResponse = {
    tag?: string;
    type: "OK" | "NO" | "BAD";

    text?: string;
} | {
    type: "PREAUTH" | "BYE";

    text?: string;
} | {
    type: "RAW";
    value: Buffer | string;
};

export default function (o: IMAPResponse) {
    const socket: IMAPSocket = this;

    switch (o.type) {
        case "OK":
        case "NO":
        case "BAD":
            socket.write(`${o.tag ?? "*"} ${o.type} ${o.text ?? o.type}\r\n`);
            break;
        case "PREAUTH":
        case "BYE":
            socket.write(`* ${o.type} ${o.text ?? o.type}\r\n`);
            break;
        case "RAW":
            socket.write(o.value);
            break;
    }
};