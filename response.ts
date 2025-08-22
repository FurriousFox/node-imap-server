import net from "node:net";

export interface IMAPSocket extends net.Socket { writeResponse?: (response: IMAPResponse) => Promise<unknown>; }

type IMAPResponse = {
    tag?: string;
    type: "OK" | "NO" | "BAD";

    text?: string;
} | {
    type: "PREAUTH" | "BYE";

    text?: string;
} | {
    type: "CONTINUE-REQ";

    text?: string;
} | {
    type: "RAW";
    value: Buffer | string;
};

export const continuation: { readonly flag: false; } | { readonly flag: true; readonly callback: (buffer: Buffer) => void; } = { flag: false };

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
        case "CONTINUE-REQ":
            (continuation as { flag: boolean; callback: Function; }).flag = true;
            let resolve: (value: unknown) => void;
            const promise = new Promise(r => resolve = r);
            (continuation as { flag: boolean; callback: Function; }).callback = function (buffer: Buffer) {
                (continuation as { flag: boolean; callback: Function; }).flag = false;
                (continuation as { flag: boolean; callback?: Function; }).callback = undefined;
                return resolve.apply(this, arguments);
            };

            socket.write(`+ ${o.text ?? ""}\r\n`);
            return promise;
            break;
        case "RAW":
            socket.write(o.value);
            break;
    }

    return new Promise<void>(r => r());
};