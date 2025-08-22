import net from "node:net";
import process from "node:process";
import { Buffer } from "node:buffer";
import _response, { IMAPSocket, continuation } from "./response.ts";

export enum IMAPSecurity {
    NONE = "none",
    // STARTTLS = "starttls",
    // TLS = "tls"
}
export type IMAPServerOptions = {
    address?: string;
    port?: number;
    security?: IMAPSecurity;
};


type IMAPConnection = {
    source: {
        port: number;
        family: 'IPv4' | 'IPv6';
        address: string;
    };
    state: Object;
};

export interface IMAPServerHandlers {
    connection: (event: {
        connection: IMAPConnection;
    }, action: {
        reject: (reason?: string) => void;
        requireLogin: () => void;
        noAuth: () => void;
    }) => any;

    close?: (event: {
        connection: IMAPConnection;
    }, action: {}) => any;

    login?: (event: {
        connection: IMAPConnection;
        username: string;
        password: string;
    }, action: {
        accept: (reason?: string) => void;
        reject: (reason?: string) => void;
    }) => any;

    unknown?: (event: {
        connection: IMAPConnection;

        rawCommand: Buffer;
        socket: net.Socket;
    }) => any;
}

export class IMAPServer {
    #options: IMAPServerOptions;
    handlers: IMAPServerHandlers;

    constructor(options: IMAPServerOptions, handlers: IMAPServerHandlers) {
        this.#options = options;
        this.handlers = handlers;

        net.createServer({
            keepAlive: true,
        }, (socket: IMAPSocket) => {
            let internal_state: "unauth" | "auth" | "selected" | "disconnected" = "unauth";
            const owrite = socket.write.bind(socket);
            socket.write = (chunk: string | Uint8Array, encodingOrCb?: BufferEncoding | ((err?: Error | null) => void), cb?: (err?: Error | null) => void): boolean => {
                process.stdout.write("S: ");
                process.stdout.write(chunk);

                if (typeof encodingOrCb === "function") {
                    return owrite(chunk, encodingOrCb);
                }
                return owrite(chunk, encodingOrCb, cb);
            };

            socket.writeResponse = _response.bind(socket);
            const writeResponse = socket.writeResponse!;

            const connection: IMAPConnection = {
                source: {
                    port: socket.remotePort!,
                    family: socket.remoteFamily! as "IPv4" | "IPv6",
                    address: socket.remoteAddress!,
                },
                state: new Object(),
            };
            let conn: { buffer: Buffer, selected: null | string; } = {
                buffer: Buffer.alloc(0),
                selected: null,
            };

            {
                let a = false;
                this.handlers.connection({ connection: connection }, {
                    reject(reason) {
                        if (!a) {
                            writeResponse({
                                type: "BYE",
                                text: reason,
                            });
                            socket.end();
                            internal_state = "disconnected";
                        }

                        a = true;
                    },
                    requireLogin() {
                        if (!a) {
                            writeResponse({
                                type: "OK",
                                text: "IMAP4rev1 Service Ready"
                            });
                            internal_state = "unauth";
                        }
                        a = true;
                    },
                    noAuth() {
                        if (!a) {
                            writeResponse({
                                type: "PREAUTH",
                                text: "IMAP4rev1 logged in"
                            });
                            internal_state = "auth";
                        }
                        a = true;
                    }
                });
            }

            function tryParse() {
                const new_line = conn.buffer.indexOf("\r\n");
                if (new_line == -1) return;
                if (continuation.flag) {
                    continuation.callback(conn.buffer.subarray(0, new_line));
                    conn.buffer = conn.buffer.subarray(new_line + 2);
                    if (internal_state !== "disconnected") tryParse();
                    return;
                }

                const line_parts = conn.buffer.subarray(0, new_line).toString().split(' ');
                const tag = line_parts.shift();
                const command = line_parts.shift()?.toUpperCase();
                // const args = line_parts;

                const args_buffer: Buffer[] = [];
                const args_string: string[] = [];
                type args = (Buffer | string | number | null | args)[];
                const args: args = [];
                const arg_start = conn.buffer.indexOf(" ", conn.buffer.indexOf(" ") + 1);
                const arg_buffer = conn.buffer.subarray(arg_start == 0 ? new_line : arg_start, new_line);
                let arg_buffer_i = 0;
                // console.log(arg_buffer.toString());
                let m = 0;
                while (m++ < 4096) {
                    const f_s = arg_buffer.indexOf(' ', arg_buffer_i);
                    const f_q = arg_buffer.indexOf('"', arg_buffer_i);
                    const f_b = arg_buffer.indexOf('{', arg_buffer_i);

                    if (f_s == -1 && f_q == -1 && f_b == -1) break;
                    if ((f_s + 1 < f_q || f_q == -1) && (f_s + 1 < f_b || f_b == -1)) {
                        // there's a space --> it's an atom, number or NIL
                        const s_s = arg_buffer.indexOf(' ', f_s + 1);
                        const arg = arg_buffer.subarray(f_s + 1, s_s == -1 ? undefined : s_s);
                        const arg_string = arg.toString();
                        args_buffer.push(arg);
                        if (arg_string.toUpperCase() == "NIL") args.push(null);
                        else {
                            if (arg.findIndex(e => (e < 48 || e > 57)) == -1) /* number */ args.push(+arg.toString());
                            else /* atom */ args.push(arg.toString());
                        }

                        arg_buffer_i = s_s;
                    } else if ((f_b < f_q || f_q == -1) && f_b !== -1) {
                        console.log("bracket time", arg_buffer.toString());
                    } else {
                        // there's a quote --> it's a quoted string
                        const s_q = arg_buffer.indexOf('"', f_q + 1);
                        const arg = arg_buffer.subarray(f_q + 1, s_q);
                        args_buffer.push(arg);
                        args.push(arg.toString());

                        arg_buffer_i = s_q + 1;
                    }

                    if (arg_buffer_i >= arg_buffer.length) break;
                }
                args_buffer.forEach(e => args_string.push(e.toString()));
                console.log(args);

                if (internal_state == "disconnected") return;

                let a = false;

                switch (command) {
                    case "CAPABILITY": // tbd auth=plain, starttls, nologin
                        socket.write("* CAPABILITY IMAP4rev1 AUTH=PLAIN\r\n");
                        socket.write(`${tag} OK OK\r\n`);
                        break;
                    case "NOOP": // tbd: status updates, e.g.
                        /*
                            S: * 22 EXPUNGE
                            S: * 23 EXISTS
                            S: * 3 RECENT
                            S: * 14 FETCH (FLAGS (\Seen \Deleted))
                        */

                        socket.write(`${tag} OK OK\r\n`);
                        break;
                    case "LOGOUT": // FULLY IMPLEMENTED
                        if (handlers.close) handlers.close({ connection }, {});

                        writeResponse({
                            type: "BYE",
                            text: "logout",
                        });
                        writeResponse({
                            tag: tag,
                            type: "OK",
                        });
                        socket.end();
                        internal_state = "disconnected";
                        break;
                    case "STARTTLS": // tbd implement starttls (and tls itself lol)
                        writeResponse({
                            tag: tag,
                            type: "BAD",
                            text: "TLS unsupported",
                        });
                        break;
                    case "AUTHENTICATE":
                        if (args[0] == "PLAIN") {
                            writeResponse({
                                type: "CONTINUE-REQ",
                            }).then((_buffer) => {
                                const buffer = _buffer as Buffer;
                                const b64d = Buffer.from(buffer.toString(), "base64");
                                const f_z = b64d.indexOf("\0");
                                const s_z = b64d.indexOf("\0", f_z + 1);

                                if (handlers.login) {
                                    switch (handlers.login({
                                        connection: connection,
                                        username: b64d.subarray(f_z + 1, s_z).toString(),
                                        password: b64d.subarray(s_z + 1).toString()
                                    }, {
                                        accept: (reason) => {
                                            if (!a) writeResponse({
                                                tag: tag,
                                                type: "OK",
                                                text: reason
                                            });
                                            a = true;
                                        },
                                        reject: (reason) => {
                                            if (!a) writeResponse({
                                                tag: tag,
                                                type: "NO",
                                                text: reason
                                            });
                                            a = true;
                                        }
                                    })) {
                                        case true:
                                            if (!a) writeResponse({
                                                tag: tag,
                                                type: "OK"
                                            });
                                            break;
                                        case false:
                                            if (!a) writeResponse({
                                                tag: tag,
                                                type: "NO"
                                            });
                                            break;
                                    }
                                } else {
                                    if (internal_state == "unauth") {
                                        writeResponse({
                                            tag: tag,
                                            type: "NO",
                                            text: "unable to authenticate"
                                        });
                                    } else {
                                        writeResponse({
                                            tag: tag,
                                            type: "OK",
                                            text: "already authenticated"
                                        });
                                    }
                                }
                            });

                            // writeResponse({
                            //     tag: tag,
                            //     type: "OK",
                            // });
                        } else writeResponse({
                            tag: tag,
                            type: "NO",
                            text: "unsupported auth mechanism",
                        });
                        // writeResponse({
                        //     tag: tag,
                        //     type: "NO"
                        // });
                        break;
                    case "LOGIN":
                        if (handlers.login) {
                            switch (handlers.login({
                                connection: connection,
                                username: args[0],
                                password: args[1]
                            }, {
                                accept: (reason) => {
                                    if (!a) writeResponse({
                                        tag: tag,
                                        type: "OK",
                                        text: reason
                                    });
                                    a = true;
                                },
                                reject: (reason) => {
                                    if (!a) writeResponse({
                                        tag: tag,
                                        type: "NO",
                                        text: reason
                                    });
                                    a = true;
                                }
                            })) {
                                case true:
                                    if (!a) writeResponse({
                                        tag: tag,
                                        type: "OK"
                                    });
                                    break;
                                case false:
                                    if (!a) writeResponse({
                                        tag: tag,
                                        type: "NO"
                                    });
                                    break;
                            }
                        } else {
                            if (internal_state == "unauth") {
                                writeResponse({
                                    tag: tag,
                                    type: "NO",
                                    text: "unable to authenticate"
                                });
                            } else {
                                writeResponse({
                                    tag: tag,
                                    type: "OK",
                                    text: "already authenticated"
                                });
                            }
                        }
                        break;
                    case "EXAMINE":
                        let is_examine = true;
                    case "SELECT":
                        socket.write(`* 10 EXISTS\r\n`);
                        socket.write(`* 1 RECENT\r\n`);
                        socket.write(`* FLAGS (\\Seen \\Deleted \\Draft)\r\n`);
                        socket.write(`* OK PERMANENTFLAGS (\\Seen \\Deleted)\r\n`);
                        socket.write(`${tag} OK OK\r\n`);
                        break;
                    case "CREATE":
                        writeResponse({
                            tag: tag,
                            type: "OK"
                        });
                        break;
                    case "DELETE":
                        writeResponse({
                            tag: tag,
                            type: "OK"
                        });
                        break;
                    case "RENAME":
                        writeResponse({
                            tag: tag,
                            type: "OK"
                        });
                        break;
                    case "SUBSCRIBE":
                        writeResponse({
                            tag: tag,
                            type: "OK"
                        });
                        break;
                    case "UNSUBSCRIBE":
                        writeResponse({
                            tag: tag,
                            type: "OK"
                        });
                        break;
                    case "LIST":
                        socket.write(`* LIST (\\Marked) "/" INBOX/foo\r\n`);
                        writeResponse({
                            tag: tag,
                            type: "OK"
                        });
                        break;
                    case "LSUB":
                        socket.write(`* LSUB (\\Marked) "/" INBOX/foo\r\n`);
                        writeResponse({
                            tag: tag,
                            type: "OK"
                        });
                        break;
                    case "STATUS":
                        socket.write(`* STATUS ${args[0]} (MESSAGES 10 RECENT 1 UNSEEN 1)\r\n`);
                        writeResponse({
                            tag: tag,
                            type: "OK"
                        });
                        break;
                    case "APPEND":
                        writeResponse({
                            tag: tag,
                            type: "OK"
                        });
                        break;
                    case "CHECK":
                        writeResponse({
                            tag: tag,
                            type: "OK"
                        });
                        break;
                    case "CLOSE":
                        internal_state = "auth";
                        writeResponse({
                            tag: tag,
                            type: "OK"
                        });
                        break;
                    case "EXPUNGE":
                        writeResponse({
                            tag: tag,
                            type: "OK"
                        });
                        break;
                    case "SEARCH":
                        writeResponse({
                            tag: tag,
                            type: "OK"
                        });
                        break;
                    case "FETCH":
                        const sequence_set = args.shift();
                        console.log(sequence_set);
                        if (sequence_set == undefined) {
                            writeResponse({
                                tag: tag,
                                type: "BAD"
                            });
                            break;
                        }

                        const seq = sequence_set.split(",").map(e => {
                            if (e.includes(":")) {
                                const g = e.split(":").map(e => e == "*" ? 10 : +e);
                                return Array(g[1] - g[0] + 1).fill(undefined).map((_, f) => f + g[0]);
                            } else {
                                return +e;
                            }
                        }).flat();
                        console.log(seq);

                        console.log(args.join(" "));

                        for (const se of seq) {
                            if (!args.join(" ").includes(".SIZE")) socket.write(`* ${se} FETCH (FLAGS (\\Seen) UID ${se})\r\n`);
                            else {
                                        /* socket.write */owrite(`* ${se} FETCH (FLAGS (\\Seen) UID ${se} RFC822.SIZE 2345 BODY[HEADER.FIELDS (From To Cc Bcc Subject Date Message-ID Priority X-Priority References Newsgroups In-Reply-To Content-Type Reply-To)] {347}\r\nFrom: Alice Example <alice@example.org>\r\nTo: Bob Example <bob@example.com>\r\nCc:\r\nBcc:\r\nSubject: Project kickoff\r\nDate: Fri, 15 Aug 2025 10:12:34 +0200\r\nMessage-ID: <msg1@example.org>\r\nPriority: normal\r\nX-Priority: 3\r\nReferences:\r\nNewsgroups:\r\nIn-Reply-To:\r\nContent-Type: text/plain; charset="UTF-8"\r\nReply-To: Alice Example <alice@example.org>\r\n\r\n)\r\n`);
                                // break;
                            }
                        }


                        writeResponse({
                            tag: tag,
                            type: "OK"
                        });
                        break;
                    case "STORE":
                        writeResponse({
                            tag: tag,
                            type: "OK"
                        });
                        break;
                    case "COPY":
                        writeResponse({
                            tag: tag,
                            type: "OK"
                        });
                        break;
                    case "UID":
                        // let g = args.shift()?.toLowerCase();
                        // console.log(args);
                        switch (args.shift()?.toLowerCase()) {
                            case "copy":
                                // copy implementation
                                writeResponse({
                                    tag: tag,
                                    type: "OK"
                                });
                                break;
                            case "fetch":
                                const sequence_set = args.shift();
                                console.log(sequence_set);
                                if (sequence_set == undefined) {
                                    writeResponse({
                                        tag: tag,
                                        type: "BAD"
                                    });
                                    break;
                                }

                                const seq = sequence_set.split(",").map(e => {
                                    if (e.includes(":")) {
                                        const g = e.split(":").map(e => e == "*" ? 10 : +e);
                                        return Array(g[1] - g[0] + 1).fill(undefined).map((_, f) => f + g[0]);
                                    } else {
                                        return +e;
                                    }
                                }).flat();
                                console.log(seq);

                                console.log(args.join(" "));

                                for (const se of seq) {
                                    if (!args.join(" ").includes(".SIZE")) socket.write(`* ${se} FETCH (FLAGS (\\Seen) UID ${se})\r\n`);
                                    else {
                                        /* socket.write */owrite(`* ${se} FETCH (FLAGS (\\Seen) UID ${se} RFC822.SIZE 2345 BODY[HEADER.FIELDS (From To Cc Bcc Subject Date Message-ID Priority X-Priority References Newsgroups In-Reply-To Content-Type Reply-To)] {347}\r\nFrom: Alice Example <alice@example.org>\r\nTo: Bob Example <bob@example.com>\r\nCc:\r\nBcc:\r\nSubject: Project kickoff\r\nDate: Fri, 15 Aug 2025 10:12:34 +0200\r\nMessage-ID: <msg1@example.org>\r\nPriority: normal\r\nX-Priority: 3\r\nReferences:\r\nNewsgroups:\r\nIn-Reply-To:\r\nContent-Type: text/plain; charset="UTF-8"\r\nReply-To: Alice Example <alice@example.org>\r\n\r\n)\r\n`);
                                        // break;
                                    }
                                }


                                writeResponse({
                                    tag: tag,
                                    type: "OK"
                                });
                                break;
                            case "store":
                                writeResponse({
                                    tag: tag,
                                    type: "OK"
                                });
                                break;
                            case "search":
                                writeResponse({
                                    tag: tag,
                                    type: "OK"
                                });
                                break;
                            default:
                                writeResponse({
                                    tag: tag,
                                    type: "BAD"
                                });
                                break;
                        }
                        break;

                    // case ""


                    // case "NOOP":
                    //     socket.write(`${tag} OK OK\r\n`);
                    //     break;
                    // case "LOGOUT":
                    //     socket.write(`* BYE BYE\r\n`);
                    //     return socket.end();
                    //     break;
                    // case "SELECT":
                    //     socket.write(`* 2 EXISTS\r\n`);
                    //     socket.write(`* 1 RECENT\r\n`);
                    //     socket.write(`* OK [UIDVALIDITY 100] UIDs valid\r\n`);
                    //     socket.write(`* OK [UIDNEXT 5] Predicted next UID\r\n`);
                    //     socket.write(`* FLAGS (\\Seen \\Deleted)\r\n`);
                    //     socket.write(`${tag} OK OK\r\n`);
                    //     conn.selected = "INBOX";
                    //     break;
                    default:
                        socket.write(`${tag} BAD BAD\r\n`);
                }

                if (new_line !== -1) conn.buffer = conn.buffer.subarray(new_line + 2);
                if (internal_state !== "disconnected") tryParse();
            }

            socket.on("data", (data) => {
                process.stdout.write("C: ");
                process.stdout.write(data);

                conn.buffer = Buffer.concat([conn.buffer, data]);

                tryParse();
            });

            socket.on("close", () => {
                if (handlers.close) handlers.close({ connection }, {});
            });
            socket.on("error", console.error);
        }).listen(options.port, options.address ?? "::1", () => {
            console.log(`listening on port ${options.address ?? "::1"}:${options.port}`);
        });
    }

    close() { }
}

export default IMAPServer;