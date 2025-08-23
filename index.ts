import net from "node:net";
import process from "node:process";
import { Buffer } from "node:buffer";
import _response, { IMAPSocket } from "./response.ts";

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

    auth?: (event: {
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

function astring(nstring: null | number | string) {
    return nstring?.toString() ?? "NIL";
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

            socket.continuation = { flag: false };
            const continuation = socket.continuation;

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
                    (continuation as unknown as { readonly flag: true; readonly callback: (buffer: Buffer) => void; }).callback(conn.buffer.subarray(0, new_line));
                    conn.buffer = conn.buffer.subarray(new_line + 2);
                    if (internal_state !== "disconnected") tryParse();
                    return;
                }

                const line_parts = conn.buffer.subarray(0, new_line).toString().split(' ');
                const tag = line_parts.shift();
                let command = line_parts.shift()?.toUpperCase();
                // const args = line_parts;

                function argParse(conn: { buffer: Buffer; } | { f_buffer: Buffer; f_c?: boolean | number; f_g?: boolean, _m: { c: number; }; }) {
                    const args_buffer: Buffer[] = [];
                    const args_string: string[] = [];
                    type args = (Buffer | string | number | null | args | Set<string | args>)[];
                    const args: args = [];
                    const arg_start = 'f_buffer' in conn ? 0 : conn.buffer.indexOf(" ", conn.buffer.indexOf(" ") + 1);
                    const arg_buffer = 'f_buffer' in conn ? conn.f_buffer : conn.buffer.subarray(arg_start == 0 ? new_line : arg_start, new_line);
                    let arg_buffer_i = 0;
                    // console.log(arg_buffer.toString());
                    let m: { c: number; } = '_m' in conn ? conn._m : { c: 0 };

                    while (m.c++ < 4096) {
                        const f_s = arg_buffer.indexOf(' ', arg_buffer_i);
                        const f_q = arg_buffer.indexOf('"', arg_buffer_i);
                        const f_b = arg_buffer.indexOf('{', arg_buffer_i);
                        const f_c = arg_buffer.indexOf('(', arg_buffer_i);
                        const f_r = arg_buffer.indexOf('[', arg_buffer_i);
                        const f_d = arg_buffer.indexOf(')', arg_buffer_i);

                        // console.log(f_s, f_q, f_b, f_c);

                        if (f_d == arg_buffer_i) { arg_buffer_i++; break; }
                        if (f_s == -1 && f_q == -1 && f_b == -1 && f_c == -1) break;
                        if ((f_s + 1 < f_q || f_q == -1) && (f_s + 1 < f_b || f_b == -1) && (f_s + 1 < f_c || f_c == -1) && f_s !== -1) {
                            // there's a space --> it's an atom, number or NIL
                            const s_s = arg_buffer.indexOf(' ', f_s + 1);
                            let arg = arg_buffer.subarray(f_s + 1, s_s == -1 ? undefined : s_s);
                            if (!arg.toString().trim().length) break;

                            if (f_r !== -1 && (f_r < s_s || s_s == -1) && (arg_buffer.subarray(f_s + 1, f_r).toString() == "BODY.PEEK" || arg_buffer.subarray(f_s + 1, f_r).toString() == "BODY")) {
                                let farg = arg_buffer.subarray(f_s + 1, f_r).toString();
                                let sarg = Buffer.concat([Buffer.from(" "), arg_buffer.subarray(f_r + 1, arg_buffer.indexOf(']', arg_buffer_i))]);
                                // console.log("sarg2", f_r + 1, arg_buffer.indexOf(']', arg_buffer_i), sarg.toString());

                                let parg = argParse({ f_buffer: sarg, f_c: true, _m: m });
                                parg.args = parg.args.map((e, f, g) => {
                                    if (g[f + 1] instanceof Array && typeof e == "string") return new Set([e, g[f + 1] as args]);
                                    else return e;
                                }).filter((e, f, g) => !(e instanceof Array && g[f - 1] instanceof Set));

                                args.push(new Set([farg, parg.args]));
                                arg_buffer_i = f_r + 1 + parg.arg_i + 1;
                                // console.log(arg_buffer_i, arg_buffer.length, JSON.stringify(arg_buffer.toString()));

                                if ('f_c' in conn && arg_buffer.at(arg_buffer_i) == 41) { arg_buffer_i++; break; }
                            } else {
                                if ('f_c' in conn && arg.at(-1) == 41) { conn.f_c = 2; arg = arg.subarray(0, -1); }
                                const arg_string = arg.toString();
                                args_buffer.push(arg);

                                // parsed as nstring by default
                                if (arg_string.toUpperCase() == "NIL") args.push(null);
                                else {
                                    if (arg.findIndex(e => (e < 48 || e > 57)) == -1) /* number */ args.push(+arg.toString());
                                    else /* atom */ args.push(arg.toString());
                                }

                                arg_buffer_i = s_s == -1 ? arg_buffer.length : s_s;

                                if ('f_c' in conn && conn.f_c == 2) break;
                            }
                        } else if ((f_b < f_q || f_q == -1) && (f_b < f_c || f_c == -1) && f_b !== -1) {
                            // literally a literal
                            console.log("bracket time", arg_buffer.toString());
                            process.exit(1);
                        } else if ((f_c < f_q || f_q == -1) && f_c !== -1) {
                            // parenthesized list
                            // console.log("list time", arg_buffer.toString());
                            // const s_c = arg_buffer.indexOf("(");
                            // const f_p = arg_buffer.indexOf(")");
                            // tbd, checks that s_p and f_p aren't inside a literal or string, 

                            // tbd: check whether there really is a second parenthesis (you pick up the entire rest of the buffer after the first “(” and feed it to the recursive call; you don’t stop at the matching “)”)

                            let sarg = Buffer.concat([Buffer.from(" "), arg_buffer.subarray(f_c + 1)]);

                            let parg = argParse({ f_buffer: sarg, f_c: true, _m: m });
                            args.push(parg.args);
                            arg_buffer_i = f_c + 1 + parg.arg_i;
                            // console.log("", args);

                            // process.exit(1);
                        } else if (f_q !== -1) {
                            // there's a quote --> it's a quoted string

                            // tbd: check whether there really is a second quote
                            let s_q: number | undefined = undefined;
                            while (m.c++ < 4096) {
                                s_q = arg_buffer.indexOf('"', s_q ? s_q + 1 : f_q + 1);

                                let g = 1;
                                let flag = false;
                                while (g < arg_buffer.length) {
                                    if (arg_buffer[s_q - g] !== 92)
                                        if (g % 2) { flag = true; break; }
                                        else { flag = false; break; }

                                    g++;
                                }
                                if (flag) break;
                            }
                            if (m.c > 4095) break;

                            const arg = arg_buffer.subarray(f_q + 1, s_q);
                            args_buffer.push(arg);
                            args.push(arg.toString().replace(/\\(.)/g, "$1"));

                            arg_buffer_i = s_q! + 1;
                        } else {
                            console.error(`uhh? can't parse ${arg_buffer.toString()}`);
                            process.exit(1);
                        }

                        if (arg_buffer_i >= arg_buffer.length) break;
                    }
                    if (m.c >= 4095) {
                        console.error(`arg structure too complex: ${arg_buffer.toString()}`);
                        process.exit(1);
                    }
                    args_buffer.forEach(e => args_string.push(e.toString()));

                    return { args_buffer, args_string, args, arg_i: arg_buffer_i };
                }
                const { args_buffer, args_string, args } = argParse(conn);
                console.log(tag, command, args);

                if (internal_state == "disconnected") return;

                let a = false;

                try {
                    let _is_uid = false;
                    if (command == "UID" && typeof args[0] == "string") if (args[0].toUpperCase() === "COPY" || args[0].toUpperCase() === "FETCH" || args[0].toUpperCase() === "STORE" || args[0].toUpperCase() === "SEARCH") _is_uid = true, command = (args.shift() as string).toUpperCase();
                    switch (command) {
                        case "CAPABILITY":
                            if (args.length !== 0) {
                                writeResponse({ tag: tag, type: "BAD", text: `unexpected amount of arguments (${args.length} instead of 0)` });
                                break;
                            }

                            // tbd starttls (should only advertise when still in unauth state), nologin (+ remove AUTH=PLAIN) (option to disallow logins over insecure connections)
                            writeResponse({
                                type: "CAPABILITY",
                                capabilities: [
                                    "IMAP4rev1",
                                    // "AUTH=PLAIN"
                                ]
                            });

                            writeResponse({ tag: tag, type: "OK", text: `${command} completed` });
                            break;
                        case "NOOP":
                            if (args.length !== 0) {
                                writeResponse({ tag: tag, type: "BAD", text: `unexpected amount of arguments (${args.length} instead of 0)` });
                                break;
                            }

                            writeResponse({ tag: tag, type: "OK", text: `${command} completed` });
                            break;
                        case "LOGOUT":
                            if (args.length !== 0) {
                                writeResponse({ tag: tag, type: "BAD", text: `unexpected amount of arguments (${args.length} instead of 0)` });
                                break;
                            }

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
                            // 1. check if there's 0 arguments
                            // 2. send "OK" (if available)
                            // 3. immediately start handshake

                            writeResponse({
                                tag: tag,
                                type: "BAD",
                                text: "TLS unsupported",
                            });
                            break;
                        case "AUTHENTICATE":
                            if (args.length !== 1) {
                                writeResponse({ tag: tag, type: "BAD", text: `unexpected amount of arguments (${args.length} instead of 0)` });
                                break;
                            }

                            if (args[0] === "PLAIN") {
                                writeResponse({
                                    type: "CONTINUE-REQ",
                                }).then((_buffer) => {
                                    const buffer = _buffer as Buffer;
                                    const b64d = Buffer.from(buffer.toString(), "base64");
                                    const f_z = b64d.indexOf("\0");
                                    const s_z = b64d.indexOf("\0", f_z + 1);

                                    if (handlers.auth) {
                                        switch (handlers.auth({
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
                            } else writeResponse({
                                tag: tag,
                                type: "NO",
                                text: "unsupported authentication mechanism",
                            });
                            break;
                        case "LOGIN":
                            if (typeof args[0] !== "string" || typeof args[1] !== "string") {
                                writeResponse({
                                    tag: tag,
                                    type: "BAD"
                                });
                            } else if (handlers.auth) {
                                switch (handlers.auth({
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
                            if (args[0] !== null && typeof args[0] !== "string" && typeof args[0] !== "number") {
                                writeResponse({
                                    tag: tag,
                                    type: "BAD",
                                });
                                break;
                            }
                            const mailbox_name: string = astring(args[0]); // nstring --> astring


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
                            console.log("is_uid", _is_uid);
                            const sequence_set = args.shift();
                            // console.log(sequence_set);

                            const details = args.shift();
                            if (!(details instanceof Array) || (typeof sequence_set !== "string" && typeof sequence_set !== "number")) {
                                writeResponse({
                                    tag: tag,
                                    type: "BAD"
                                });
                                break;
                            }

                            const seq = sequence_set.toString().split(",").map(e => {
                                if (e.includes(":")) {
                                    const g = e.split(":").map(e => e == "*" ? 10 : +e);
                                    return Array(g[1] - g[0] + 1).fill(undefined).map((_, f) => f + g[0]);
                                } else {
                                    return +e;
                                }
                            }).flat();
                            console.log(seq);

                            for (const se of seq) {
                                if (!details.includes("RFC822.SIZE")) socket.write(`* ${se} FETCH (FLAGS (\\Seen) UID ${se})\r\n`);
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
                        // case "UID":
                        //     // let g = args.shift()?.toLowerCase();
                        //     // console.log(args);

                        //     const type = args.shift();
                        //     // console.log(type);
                        //     if (typeof type !== "string") {
                        //         writeResponse({
                        //             tag: tag,
                        //             type: "BAD"
                        //         });
                        //         break;
                        //     }

                        //     switch (type.toLowerCase()) {
                        //         case "copy":
                        //             // copy implementation
                        //             writeResponse({
                        //                 tag: tag,
                        //                 type: "OK"
                        //             });
                        //             break;
                        //         case "fetch":
                        //             const sequence_set = args.shift();
                        //             // console.log(sequence_set);

                        //             const details = args.shift();
                        //             if (!(details instanceof Array) || (typeof sequence_set !== "string" && typeof sequence_set !== "number")) {
                        //                 writeResponse({
                        //                     tag: tag,
                        //                     type: "BAD"
                        //                 });
                        //                 break;
                        //             }

                        //             const seq = sequence_set.toString().split(",").map(e => {
                        //                 if (e.includes(":")) {
                        //                     const g = e.split(":").map(e => e == "*" ? 10 : +e);
                        //                     return Array(g[1] - g[0] + 1).fill(undefined).map((_, f) => f + g[0]);
                        //                 } else {
                        //                     return +e;
                        //                 }
                        //             }).flat();
                        //             console.log(seq);

                        //             for (const se of seq) {
                        //                 if (!details.includes("RFC822.SIZE")) socket.write(`* ${se} FETCH (FLAGS (\\Seen) UID ${se})\r\n`);
                        //                 else {
                        //                     /* socket.write */owrite(`* ${se} FETCH (FLAGS (\\Seen) UID ${se} RFC822.SIZE 2345 BODY[HEADER.FIELDS (From To Cc Bcc Subject Date Message-ID Priority X-Priority References Newsgroups In-Reply-To Content-Type Reply-To)] {347}\r\nFrom: Alice Example <alice@example.org>\r\nTo: Bob Example <bob@example.com>\r\nCc:\r\nBcc:\r\nSubject: Project kickoff\r\nDate: Fri, 15 Aug 2025 10:12:34 +0200\r\nMessage-ID: <msg1@example.org>\r\nPriority: normal\r\nX-Priority: 3\r\nReferences:\r\nNewsgroups:\r\nIn-Reply-To:\r\nContent-Type: text/plain; charset="UTF-8"\r\nReply-To: Alice Example <alice@example.org>\r\n\r\n)\r\n`);
                        //                     // break;
                        //                 }
                        //             }


                        //             writeResponse({
                        //                 tag: tag,
                        //                 type: "OK"
                        //             });
                        //             break;
                        //         case "store":
                        //             writeResponse({
                        //                 tag: tag,
                        //                 type: "OK"
                        //             });
                        //             break;
                        //         case "search":
                        //             writeResponse({
                        //                 tag: tag,
                        //                 type: "OK"
                        //             });
                        //             break;
                        //         default:
                        //             writeResponse({
                        //                 tag: tag,
                        //                 type: "BAD"
                        //             });
                        //             break;
                        //     }
                        //     break;

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
                } catch (_e) {
                    console.error(_e);

                    writeResponse({
                        type: "BAD",
                        text: `Internal server error`
                    });
                    writeResponse({
                        type: "BYE",
                        text: `Internal server error while handling ${command} (${tag})`
                    });

                    socket.end();
                    internal_state = "disconnected";

                    process.exit(1);
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