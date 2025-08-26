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

enum IMAPState {
    unauth = "unauth",
    auth = "auth",
    selected = "selected",
    disconnected = "disconnected",
    examined = "examined"
}

let connection_counter = 0;
type IMAPConnection = {
    source: {
        port: number;
        family: 'IPv4' | 'IPv6';
        address: string;
    };
    id: number;
    state: Object;
};

type IMAPBox = {
    name: string;
    id?: any;
    subboxes?: IMAPBox[];

    flags: ("\\Seen" | "\\Deleted" | "\\Draft" | "\\Answered" | "\\Recent" | "\\Flagged")[];
    permanentflags: Exclude<IMAPBox["flags"][number], "\\Recent">[];

    messages: {
        count: number;
        unread_count: number;
        recent_count?: number;
    };
};

export interface IMAPServerHandlers {
    connection?: (event: {
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
    }) => void | boolean | Promise<boolean | void>;

    boxes: (event: {
        connection: IMAPConnection;
    }, action: {
        resolve: (boxes: IMAPBox[]) => void;
    }) => void | IMAPBox[] | Promise<IMAPBox[] | void>;

    unknown?: (event: {
        connection: IMAPConnection;

        rawCommand: Buffer;
        socket: net.Socket;
    }) => any;
}

type nstring = (null | number | string);
function astring(nstring: nstring) {
    return nstring?.toString() ?? "NIL";
}
function isnstring(nstring: any): nstring is nstring {
    return (nstring == null || typeof nstring == "number" || typeof nstring == "string");
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
            let internal_state: IMAPState = IMAPState.unauth as IMAPState;

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
                id: ++connection_counter,
                state: new Object(),
            };
            let conn: { buffer: Buffer, selected: null | string; } = {
                buffer: Buffer.alloc(0),
                selected: null,
            };

            async function getBoxes(): Promise<IMAPBox[]> {
                function flatten(boxes: IMAPBox[], prefix: string = ""): IMAPBox[] {
                    const flat: IMAPBox[] = [];

                    for (const box of boxes) {
                        const shallow_box = Object.assign({}, box);
                        shallow_box.name = `${prefix}${box.name}`;
                        flat.push(shallow_box);

                        if (box.subboxes) flat.push(...flatten(box.subboxes, `${prefix}${box.name}/`));
                    }

                    return flat;
                }

                return flatten(await new Promise<IMAPBox[]>((resolve) => {
                    try {
                        const result = handlers.boxes({ connection }, {
                            resolve: (boxes: IMAPBox[]) => {
                                resolve(boxes);
                            }
                        });
                        if (result instanceof Promise) {
                            result.then((value) => resolve(value ?? [])).catch((_e) => { console.error(_e); resolve([]); });
                        } else if (result !== undefined) {
                            resolve(result);
                        }
                    } catch (_e) {
                        console.error(_e); resolve([]);
                    }
                }));
            }


            function internalError(error: {
                error: Error;
            } | {
                error: Error;
                tag: string;
                command: string;
            }) {
                console.error(error.error);

                writeResponse({
                    tag: 'tag' in error ? error.tag : undefined,
                    type: "BAD",
                    text: `Internal server error`
                });
                writeResponse({
                    type: "BYE",
                    text: `Internal server error${'command' in error ? ` while handling ${error.command} (${error.tag})` : ""}`
                });

                socket.end();
                internal_state = IMAPState.disconnected;
            }

            {
                let a = false;
                if (handlers.connection) {
                    try {
                        handlers.connection({ connection: connection }, {
                            reject(reason) {
                                if (!a) {
                                    writeResponse({
                                        type: "BYE",
                                        text: reason,
                                    });
                                    socket.end();
                                    internal_state = IMAPState.disconnected;
                                }

                                a = true;
                            },
                            requireLogin() {
                                if (!a) {
                                    writeResponse({
                                        type: "OK",
                                        text: "IMAP4rev1 Service Ready"
                                    });
                                    internal_state = IMAPState.unauth;
                                }
                                a = true;
                            },
                            noAuth() {
                                if (!a) {
                                    writeResponse({
                                        type: "PREAUTH",
                                        text: "IMAP4rev1 logged in"
                                    });
                                    internal_state = IMAPState.auth;
                                }
                                a = true;
                            }
                        });
                    } catch (_e) {
                        if (!a) {
                            writeResponse({
                                type: "BYE",
                                text: "Internal server error while handling new connection",
                            });
                            socket.end();
                            internal_state = IMAPState.disconnected;
                            return;
                        }
                    }
                } else {
                    if (!a) {
                        writeResponse({
                            type: "OK",
                            text: "IMAP4rev1 Service Ready"
                        });
                        internal_state = IMAPState.unauth;
                    }
                    a = true;
                }
            }

            async function tryParse() {
                const new_line = conn.buffer.indexOf("\r\n");
                if (new_line == -1) return;

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
                    if (!('f_buffer' in conn)) conn.buffer = conn.buffer.subarray(new_line + 2);

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

                if (internal_state == IMAPState.disconnected) return;

                let a = false;

                try {
                    let _is_uid, _is_examine = false;
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
                                    "AUTH=PLAIN"
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

                            if (handlers.close) {
                                try {
                                    handlers.close({ connection }, {});
                                } catch (_e) {
                                    console.error(_e);
                                }
                            }

                            writeResponse({
                                type: "BYE",
                                text: "logout",
                            });
                            writeResponse({
                                tag: tag,
                                type: "OK",
                                text: "LOGOUT"
                            });
                            socket.end();
                            internal_state = IMAPState.disconnected;
                            break;
                        case "STARTTLS": // tbd implement starttls (and tls itself lol)
                            // 1. check if there's 0 arguments (else BAD)
                            // 2. check if state == unauth (else BAD)
                            // 2. send "OK" (if available, else BAD)
                            // 3. immediately start handshake

                            writeResponse({
                                tag: tag,
                                type: "BAD",
                                text: "TLS unsupported",
                            });
                            break;
                        case "AUTHENTICATE":
                            if (internal_state !== IMAPState.unauth) {
                                writeResponse({ tag: tag, type: "BAD", text: `command only available in unauthenticated state` });
                                break;
                            }
                            if (args.length !== 1) {
                                writeResponse({ tag: tag, type: "BAD", text: `unexpected amount of arguments (${args.length} instead of 1)` });
                                break;
                            }

                            if (args[0] === "PLAIN") {
                                let _buffer = await writeResponse({
                                    type: "CONTINUE-REQ",
                                }).catch(() => { });

                                try {
                                    const buffer = _buffer as Buffer;
                                    if (buffer.toString().trim() == "*") {
                                        return writeResponse({
                                            tag: tag,
                                            type: "BAD",
                                            text: "authentication cancelled"
                                        });
                                    }

                                    const b64d = Buffer.from(buffer.toString(), "base64");
                                    const f_z = b64d.indexOf("\0");
                                    const s_z = b64d.indexOf("\0", f_z + 1);

                                    if (handlers.auth) {
                                        try {
                                            let c: Promise<boolean | void> | boolean | void;
                                            switch (c = handlers.auth({
                                                connection: connection,
                                                username: b64d.subarray(f_z + 1, s_z).toString(),
                                                password: b64d.subarray(s_z + 1).toString()
                                            }, {
                                                accept: (reason) => {
                                                    if (!a) {
                                                        writeResponse({
                                                            tag: tag,
                                                            type: "OK",
                                                            text: reason
                                                        });
                                                        a = true;

                                                        internal_state = IMAPState.auth;
                                                    }
                                                },
                                                reject: (reason) => {
                                                    if (!a) {
                                                        writeResponse({
                                                            tag: tag,
                                                            type: "NO",
                                                            text: reason
                                                        });
                                                        a = true;

                                                        internal_state = IMAPState.unauth;
                                                    }
                                                }
                                            })) {
                                                case true:
                                                    if (!a) {
                                                        writeResponse({
                                                            tag: tag,
                                                            type: "OK"
                                                        });
                                                        a = true;

                                                        internal_state = IMAPState.auth;
                                                        break;
                                                    }
                                                case false:
                                                    if (!a) {
                                                        writeResponse({
                                                            tag: tag,
                                                            type: "NO"
                                                        });
                                                        a = true;

                                                        internal_state = IMAPState.unauth;
                                                        break;
                                                    }
                                            }

                                            if (c instanceof Promise) {
                                                c.catch((_e) => {
                                                    internalError({
                                                        error: _e,
                                                        tag: tag,
                                                        command: command
                                                    });
                                                });

                                                await c;

                                                if (a) return;

                                                if (await c == true) {
                                                    writeResponse({
                                                        tag: tag,
                                                        type: "OK"
                                                    });
                                                    a = true;

                                                    internal_state = IMAPState.auth;
                                                    return;
                                                } else if (await c == false) {
                                                    writeResponse({
                                                        tag: tag,
                                                        type: "NO"
                                                    });
                                                    a = true;

                                                    internal_state = IMAPState.unauth;
                                                }
                                            }
                                        } catch (_e) {
                                            internalError({
                                                error: _e,
                                                tag: tag,
                                                command: command
                                            });
                                        }
                                    } else {
                                        writeResponse({
                                            tag: tag,
                                            type: "BAD",
                                            text: "authentication unavailable"
                                        });
                                    }
                                } catch (_e) {
                                    writeResponse({
                                        tag: tag,
                                        type: "BAD",
                                        text: "unable to handle (likely invalid) client input"
                                    });
                                }

                            } else writeResponse({
                                tag: tag,
                                type: "NO",
                                text: "unsupported authentication mechanism",
                            });
                            break;
                        case "LOGIN":
                            if (internal_state !== IMAPState.unauth) {
                                writeResponse({ tag: tag, type: "BAD", text: `command only available in unauthenticated state` });
                                break;
                            }
                            if (args.length !== 2) {
                                writeResponse({ tag: tag, type: "BAD", text: `unexpected amount of arguments (${args.length} instead of 2)` });
                                break;
                            }

                            if (!isnstring(args[0]) || !isnstring(args[1])) {
                                writeResponse({
                                    tag: tag,
                                    type: "BAD",
                                    text: "invalid arguments"
                                });
                            } else if (handlers.auth) {
                                try {
                                    let c: Promise<boolean | void> | boolean | void;

                                    switch (c = handlers.auth({
                                        connection: connection,
                                        username: astring(args[0]),
                                        password: astring(args[1])
                                    }, {
                                        accept: (reason) => {
                                            if (!a) {
                                                writeResponse({
                                                    tag: tag,
                                                    type: "OK",
                                                    text: reason
                                                });
                                                a = true;

                                                internal_state = IMAPState.auth;
                                            }
                                        },
                                        reject: (reason) => {
                                            if (!a) {
                                                writeResponse({
                                                    tag: tag,
                                                    type: "NO",
                                                    text: reason
                                                });
                                                a = true;

                                                internal_state = IMAPState.unauth;
                                            }
                                        }
                                    })) {
                                        case true:
                                            if (!a) {
                                                writeResponse({
                                                    tag: tag,
                                                    type: "OK"
                                                });

                                                internal_state = IMAPState.auth;
                                                break;
                                            }
                                        case false:
                                            if (!a) {
                                                writeResponse({
                                                    tag: tag,
                                                    type: "NO"
                                                });

                                                internal_state = IMAPState.unauth;
                                                break;
                                            }
                                    }

                                    if (c instanceof Promise) {
                                        c.catch((_e) => {
                                            internalError({
                                                error: _e,
                                                tag: tag,
                                                command: command
                                            });
                                        });

                                        await c;

                                        if (a) return;

                                        if (await c == true) {
                                            writeResponse({
                                                tag: tag,
                                                type: "OK"
                                            });
                                            a = true;

                                            internal_state = IMAPState.auth;
                                            return;
                                        } else if (await c == false) {
                                            writeResponse({
                                                tag: tag,
                                                type: "NO"
                                            });
                                            a = true;

                                            internal_state = IMAPState.unauth;
                                        }
                                    }
                                } catch (_e) {
                                    internalError({
                                        error: _e,
                                        tag: tag,
                                        command: command
                                    });
                                }
                            } else {
                                writeResponse({
                                    tag: tag,
                                    type: "BAD",
                                    text: "authentication unavailable"
                                });
                            }
                            break;
                        case "EXAMINE":
                            _is_examine = true;
                        case "SELECT":
                            if (internal_state == IMAPState.unauth) {
                                writeResponse({ tag: tag, type: "BAD", text: `authentication required` });
                                break;
                            }
                            if (args.length !== 1) {
                                writeResponse({ tag: tag, type: "BAD", text: `unexpected amount of arguments (${args.length} instead of 1)` });
                                break;
                            }
                            if (!isnstring(args[0])) {
                                writeResponse({
                                    tag: tag,
                                    type: "BAD",
                                    text: "invalid mailbox name"
                                });
                                break;
                            }
                            const mailbox_name: string = astring(args[0]).toUpperCase() == "INBOX" ? "INBOX" : astring(args[0]);
                            /*
                             If the client is permitted to modify the mailbox, the server
                             SHOULD prefix the text of the tagged OK response with the
                             "" response code.
                            */

                            const boxes = await getBoxes();
                            if (!(boxes.filter(box => box.name == mailbox_name).length)) {
                                writeResponse({
                                    tag: tag,
                                    type: "NO",
                                    text: "mailbox unavailable"
                                });
                                conn.selected = null;
                                internal_state = IMAPState.auth;
                                break;
                            }
                            const box: IMAPBox = boxes.filter(box => box.name == mailbox_name)[0];

                            // get information about mailbox
                            /*
                            untagged: 
                             FLAGS flag parenthesized list; FLAGS (\Answered \Flagged \Deleted \Seen \Draft \Recent)
                                the flags defined in the mailbox

                             <n> EXISTS; 100 EXISTS
                                the number of messages in the mailbox

                             <n> RECENT; 25 RECENT
                                the number of messages with the \Recent flag set

                             OK [UNSEEN <n>] message; OK [UNSEEN 13] UNSEEN
                                *sequence number* of the first unread message
                               
                             OK [PERMANENTFLAGS (flags)] message; OK [PERMANENTFLAGS (\Deleted \Seen (\Draft maybe??))] PERMANENTFLAGS
                                flags that can be modified permanently

                             OK [UIDNEXT <n>] message; OK [UIDNEXT 4392] UIDNEXT
                                predicted next UID

                             OK [UIDVALIDITY <n>] message; OK [UIDVALIDITY 1234] UIDVALIDITY
                                the unique identifier validity value
                                
                            The combination of mailbox name, UIDVALIDITY, and UID must refer to a single immutable message on that server forever
                            */

                            // socket.write(`* 10 EXISTS\r\n`);
                            socket.write(`* ${box.messages.count} EXISTS\r\n`);

                            // socket.write(`* 1 RECENT\r\n`);
                            socket.write(`* ${box.messages.recent_count ?? box.messages.count} RECENT\r\n`);

                            // UNSEEN
                            socket.write(`* OK [UNSEEN ${box.messages.unread_count}] UNSEEN\r\n`);

                            // socket.write(`* FLAGS (\\Seen \\Deleted \\Draft)\r\n`);
                            socket.write(`* FLAGS (${box.flags.join(" ")})\r\n`);

                            // socket.write(`* OK PERMANENTFLAGS ${_is_examine ? "()" : "(\\Seen \\Deleted)"}\r\n`);
                            socket.write(`* OK [PERMANENTFLAGS ${_is_examine ? "()" : `(${box.permanentflags.join(" ")})`}] PERMANENTFLAGS\r\n`);

                            // UIDNEXT
                            // UIDVALIDITY

                            conn.selected = mailbox_name;
                            internal_state = _is_examine ? IMAPState.examined : IMAPState.selected;
                            socket.write(`${tag} ${_is_examine ? "[READ-ONLY]" : "[READ-WRITE]"} OK SELECT\r\n`);
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
                        case "LIST": {
                            // internal_state
                            // args[]

                            const boxes = await getBoxes();

                            // tbd: \Noinferiors(?)
                            // NOTE: There can be multiple LIST responses for a single LIST command.

                            for (const box of boxes) {
                                socket.write(`* LIST () "/" ${box.name}\r\n`);
                            }

                            writeResponse({
                                tag: tag,
                                type: "OK"
                            });
                            break;
                        }
                        case "LSUB": {
                            const boxes = await getBoxes();

                            // tbd: \Noinferiors(?)
                            // NOTE: There can be multiple LIST responses for a single LIST command.

                            for (const box of boxes) {
                                socket.write(`* LSUB () "/" ${box.name}\r\n`);
                            }
                            // socket.write(`* LSUB (\\Marked) "/" INBOX/foo\r\n`);

                            writeResponse({
                                tag: tag,
                                type: "OK"
                            });
                            break;
                        }
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
                            internal_state = IMAPState.auth;
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
                        tag: tag,
                        type: "BAD",
                        text: "unable to handle (likely invalid) client input"
                    });

                    // writeResponse({
                    //     type: "BAD",
                    //     text: `Internal server error`
                    // });
                    // writeResponse({
                    //     type: "BYE",
                    //     text: `Internal server error while handling ${command} (${tag})`
                    // });

                    // socket.end();
                    // internal_state = IMAPState.disconnected;

                    // process.exit(1);
                }
            }

            const resolveness: {
                resolve: () => void,
                resolveable: boolean,
                timeout: NodeJS.Timeout,
            } = {
                resolve: () => { },
                resolveable: false,
                timeout: setTimeout(() => { })
            };

            (async () => {
                while (true) {
                    if (internal_state == IMAPState.disconnected) break;

                    if (conn.buffer.indexOf("\r\n") !== -1) await tryParse().catch(() => { });

                    if (conn.buffer.indexOf("\r\n") == -1) {
                        const promise = new Promise(r => {
                            resolveness.resolve = r as typeof resolveness.resolve;
                            resolveness.timeout = setTimeout(() => {
                                if (resolveness.resolveable) {
                                    resolveness.resolveable = false;
                                    resolveness.resolve();
                                }
                            }, 1000);
                        });
                        resolveness.resolveable = true;

                        await promise;
                    }
                }
            })();

            socket.on("data", (data) => {
                process.stdout.write("C: ");
                process.stdout.write(data);

                conn.buffer = Buffer.concat([conn.buffer, data]);

                if (resolveness.resolveable) {
                    resolveness.resolveable = false;
                    clearTimeout(resolveness.timeout);
                    resolveness.resolve();
                }

                if (continuation.flag) {
                    (continuation as unknown as { readonly flag: true; readonly callback: (buffer: Buffer) => void; }).callback(conn.buffer.subarray(0, conn.buffer.indexOf("\r\n")));
                    conn.buffer = conn.buffer.subarray(conn.buffer.indexOf("\r\n") + 2);
                    return;
                }
            });

            const continue_interval = setInterval(() => {
                if (internal_state == IMAPState.disconnected) clearInterval(continue_interval);

                if (continuation.flag) {
                    (continuation as unknown as { readonly flag: true; readonly callback: (buffer: Buffer) => void; }).callback(conn.buffer.subarray(0, conn.buffer.indexOf("\r\n")));
                    conn.buffer = conn.buffer.subarray(conn.buffer.indexOf("\r\n") + 2);
                    return;
                }
            }, 100);

            socket.on("close", () => {
                internal_state = IMAPState.disconnected;
                if (handlers.close) {
                    try {
                        handlers.close({ connection }, {});
                    } catch (_e) {
                        console.error(_e);
                    }
                }
            });
            socket.on("error", /* console.error */() => { });
        }).listen(options.port, options.address ?? "::1", () => {
            console.log(`listening on port ${options.address ?? "::1"}:${options.port}`);
        });
    }

    close() { }
}

export default IMAPServer;