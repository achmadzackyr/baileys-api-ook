import { rmSync, readdir } from 'fs'
import { join } from 'path'
import pino from 'pino'
import makeWASocket, {
    makeWALegacySocket,
    useMultiFileAuthState,
    useSingleFileLegacyAuthState,
    makeInMemoryStore,
    Browsers,
    DisconnectReason,
    delay,
} from '@adiwajshing/baileys'
import { toDataURL } from 'qrcode'
import __dirname from './dirname.js'
import response from './response.js'
import axios from 'axios'
import * as qs from 'qs'

const sessions = new Map()
const retries = new Map()

const sessionsDir = (sessionId = '') => {
    return join(__dirname, 'sessions', sessionId ? sessionId : '')
}

const isSessionExists = (sessionId) => {
    return sessions.has(sessionId)
}

const shouldReconnect = (sessionId) => {
    let maxRetries = parseInt(process.env.MAX_RETRIES ?? 0)
    let attempts = retries.get(sessionId) ?? 0

    maxRetries = maxRetries < 1 ? 1 : maxRetries

    if (attempts < maxRetries) {
        ++attempts

        console.log('Reconnecting...', { attempts, sessionId })
        retries.set(sessionId, attempts)

        return true
    }

    return false
}

const createSession = async (sessionId, isLegacy = false, res = null) => {
    const sessionFile = (isLegacy ? 'legacy_' : 'md_') + sessionId + (isLegacy ? '.json' : '')

    const logger = pino({ level: 'warn' })
    const store = makeInMemoryStore({ logger })

    let state, saveState

    if (isLegacy) {
        ;({ state, saveState } = useSingleFileLegacyAuthState(sessionsDir(sessionFile)))
    } else {
        ;({ state, saveCreds: saveState } = await useMultiFileAuthState(sessionsDir(sessionFile)))
    }

    /**
     * @type {import('@adiwajshing/baileys').CommonSocketConfig}
     */
    const waConfig = {
        auth: state,
        printQRInTerminal: true,
        logger,
        browser: Browsers.ubuntu('Chrome'),
    }

    /**
     * @type {import('@adiwajshing/baileys').AnyWASocket}
     */
    const wa = isLegacy ? makeWALegacySocket(waConfig) : makeWASocket.default(waConfig)

    if (!isLegacy) {
        store.readFromFile(sessionsDir(`${sessionId}_store.json`))
        store.bind(wa.ev)
    }

    sessions.set(sessionId, { ...wa, store, isLegacy })

    wa.ev.on('creds.update', saveState)

    wa.ev.on('chats.set', ({ chats }) => {
        if (isLegacy) {
            store.chats.insertIfAbsent(...chats)
        }
    })

    // Automatically read incoming messages, uncomment below codes to enable this behaviour
    wa.ev.on('messages.upsert', async (m) => {
        const message = m.messages[0]
        const splittedRemoteJid = message.key.remoteJid.split('@')

        if (
            !message.key.fromMe &&
            m.type === 'notify' &&
            message.key.remoteJid != 'status@broadcast' &&
            splittedRemoteJid[1] == 's.whatsapp.net'
        ) {
            await delay(1000)
            if (message.message.conversation == '!ping') {
                await wa.sendMessage(message.key.remoteJid, { text: 'pong' })
            } else if (message.message.conversation.charAt(0) == '#') {
                //insert ke log

                let replyText = 'Konfirmasi Data Pemesanan \n\n'
                var splittedArray = message.message.conversation.substring(1).split('#')

                if (splittedArray.length != 7) {
                    let invalidChat = 'Chat anda tidak sesuai format. Silahkan ulangi lagi! \n\n'
                    invalidChat += 'Format chat: \n\n'
                    invalidChat += '#Nama#Alamat#Kodepos#No Hp#sku produk#jumlah pesan#COD (Y/N) \n\n'
                    invalidChat += 'Contoh chat: \n\n'
                    invalidChat +=
                        '#Budi#Jl.Tomang Raya No.11 Kelurahan Tomang Kec.GROGOL PETAMBURAN Jakarta Barat#11440#08123456789#produk-abc#1#Y\n'
                    await wa.sendMessage(message.key.remoteJid, { text: invalidChat })
                    return false
                }

                //cek jika jumlah pesan bukan angka

                //Get user by phone
                axios({
                    method: 'post',
                    url: 'https://api.wangsiap.com/api/users/get-user-by-phone',
                    headers: {
                        Accept: 'application/json',
                        'Content-Type': 'application/x-www-form-urlencoded',
                    },
                    data: qs.stringify({
                        hp: sessionId,
                    }),
                })
                    .then(function (response) {
                        const userId = response.data.data.id
                        const userFrom = response.data.data.from
                        //cek sku produk dapetin nama, berat dan harga
                        let produk = {}
                        axios({
                            method: 'post',
                            url: 'https://api.wangsiap.com/api/products/getBySku',
                            headers: {
                                'Content-Type': 'application/x-www-form-urlencoded',
                            },
                            data: qs.stringify({
                                sku: splittedArray[4],
                                user_id: userId,
                            }),
                        })
                            .then(function (response) {
                                produk = response.data.data

                                //cek kodepos dapetin tarif_code, kabupaten, propinsi
                                let destination = {}
                                axios({
                                    method: 'post',
                                    url: 'https://api.wangsiap.com/api/gateway/get-destinations-by-zip',
                                    headers: {
                                        'Content-Type': 'application/x-www-form-urlencoded',
                                    },
                                    data: qs.stringify({
                                        kodepos: splittedArray[2],
                                    }),
                                })
                                    .then(function (response) {
                                        if (response.data.data.length > 0) {
                                            destination = response.data.data[0]
                                            //hitung total harga
                                            const totalPcs = +splittedArray[5]
                                            const totalBerat = Math.round(produk.berat) * totalPcs

                                            //cek tariff_code pengirim berdasarkan no hp
                                            axios({
                                                method: 'post',
                                                url: 'http://apiv2.jne.co.id:10101/tracing/api/pricedev',
                                                headers: {
                                                    'Content-Type': 'application/x-www-form-urlencoded',
                                                },
                                                data: qs.stringify({
                                                    username: 'TMS',
                                                    api_key: 'dc32eb483f724dd82af7b1754802de5d',
                                                    from: userFrom,
                                                    thru: destination.TARIFF_CODE,
                                                    weight: totalBerat,
                                                }),
                                            })
                                                .then(function (response) {
                                                    const tariff = response.data.price.filter(
                                                        (x) =>
                                                            x.service_display === 'REG' || x.service_display === 'CTC'
                                                    )[0]

                                                    const totalOngkir = Math.round(tariff.price)
                                                    const totalHarga = Math.round(produk.harga) * totalPcs + totalOngkir

                                                    replyText += 'Nama: ' + splittedArray[0] + ' \n'
                                                    replyText += 'Alamat: ' + splittedArray[1] + ' \n'
                                                    replyText += 'Kodepos: ' + splittedArray[2] + ' \n'
                                                    replyText += 'No.Hp: ' + splittedArray[3] + ' \n'
                                                    replyText +=
                                                        'COD: ' + (splittedArray[6] === 'Y' ? 'Ya' : 'Tidak') + ' \n\n'
                                                    replyText +=
                                                        'Kodepos ' +
                                                        splittedArray[2] +
                                                        ' masuk ke Kabupaten / Kota ' +
                                                        destination.CITY_NAME +
                                                        ' Kecamatan ' +
                                                        destination.DISTRICT_NAME +
                                                        ' \n\n'

                                                    replyText += 'Pesanan: ' + produk.nama + ' \n'
                                                    replyText +=
                                                        'Harga: Rp' +
                                                        Number(Math.round(produk.harga).toFixed(1)).toLocaleString(
                                                            'id-ID'
                                                        ) +
                                                        ' \n'
                                                    replyText += 'Jumlah Pesan: ' + splittedArray[5] + ' \n\n'

                                                    replyText +=
                                                        'Ongkir: Rp' +
                                                        Number(totalOngkir.toFixed(1)).toLocaleString('id-ID') +
                                                        ' \n'
                                                    replyText +=
                                                        'Total Harga: Rp' +
                                                        Number(totalHarga.toFixed(1)).toLocaleString('id-ID') +
                                                        ' \n\n'

                                                    replyText += '*Apakah sudah sesuai?* \n'
                                                    const expiredDate = new Date(
                                                        Date.now() + 8 * (60 * 60 * 1000)
                                                    ).toLocaleString('id-ID')

                                                    wa.sendMessage(message.key.remoteJid, {
                                                        text: replyText,
                                                        footer: `(Lakukan konfirmasi maksimal ${expiredDate})`,
                                                        buttons: [
                                                            {
                                                                buttonId: 'confirm-order',
                                                                buttonText: {
                                                                    displayText: 'Ya, Pesanan Saya Sudah Sesuai',
                                                                },
                                                                type: 1,
                                                            },
                                                            {
                                                                buttonId: 'cancel-order',
                                                                buttonText: {
                                                                    displayText: 'Tidak, Batalkan Pesanan Saya',
                                                                },
                                                                type: 1,
                                                            },
                                                        ],
                                                        headerType: 1,
                                                    })

                                                    axios({
                                                        method: 'post',
                                                        url: 'http://api.wangsiap.com/api/gateway/order',
                                                        headers: {
                                                            'Content-Type': 'application/x-www-form-urlencoded',
                                                        },
                                                        data: qs.stringify({
                                                            message: message.message.conversation,
                                                            sender: splittedRemoteJid[0],
                                                            receiver: sessionId,
                                                            order_status_id: '1',
                                                        }),
                                                    })
                                                        .then(function (response) {
                                                            //msg.reply('Pesanan berhasil!');
                                                        })
                                                        .catch(function (error) {
                                                            wa.sendMessage(message.key.remoteJid, {
                                                                text: 'Gangguan koneksi saat input order. Silahkan coba lagi!',
                                                            })
                                                            return false
                                                        })
                                                })
                                                .catch(function (error) {
                                                    wa.sendMessage(message.key.remoteJid, {
                                                        text: 'Gangguan koneksi saat cek tarif. Silahkan coba lagi!',
                                                    })
                                                    return false
                                                })
                                        } else {
                                            wa.sendMessage(message.key.remoteJid, {
                                                text: 'Kodepos tidak ditemukan harap cari dan cek kodeposmu di https://wangsiap.com/kodepos',
                                            })
                                            return false
                                        }
                                    })
                                    .catch(function (error) {
                                        wa.sendMessage(message.key.remoteJid, {
                                            text: 'Kodepos tidak ditemukan harap cari dan cek kodeposmu di https://wangsiap.com/kodepos',
                                        })
                                        return false
                                    })
                            })
                            .catch(function (error) {
                                wa.sendMessage(message.key.remoteJid, {
                                    text: 'Gagal saat pengecekan data barang. Silahkan periksa penulisan SKU dan coba lagi!',
                                })
                                return false
                            })
                    })
                    .catch(function (error) {
                        wa.sendMessage(message.key.remoteJid, {
                            text: 'Gangguan koneksi saat pengecekan data penjual. Silahkan coba lagi!',
                        })
                        return false
                    })
            } else if (message.message.buttonsResponseMessage) {
                if (message.message.buttonsResponseMessage.selectedButtonId == 'confirm-order') {
                    //cek tabel order jika (latest create date < 1 jam dan status = 1) maka approve ubah status jadi 2
                    axios({
                        method: 'post',
                        url: 'https://api.wangsiap.com/api/orders/get-latest-by-sender',
                        headers: {
                            'Content-Type': 'application/x-www-form-urlencoded',
                        },
                        data: qs.stringify({
                            no_pengirim: splittedRemoteJid[0],
                        }),
                    })
                        .then(function (response) {
                            if (response.data.data != null) {
                                axios({
                                    method: 'post',
                                    url: `https://api.wangsiap.com/api/orders/update-status/${response.data.data.id}`,
                                    headers: {
                                        Accept: 'application/json',
                                        'Content-Type': 'application/x-www-form-urlencoded',
                                    },
                                    data: qs.stringify({
                                        order_status_id: '2',
                                        _method: 'PUT',
                                    }),
                                })
                                    .then(function (response) {
                                        if (response.data.data != null) {
                                            //thank you text harusnya berdasarkan setting user
                                            //conditional jika cod atau transfer
                                            wa.sendMessage(message.key.remoteJid, {
                                                text: 'Terima kasih! Pesanan sudah masuk dan akan segera diproses',
                                            })
                                        }
                                    })
                                    .catch(function (error) {
                                        wa.sendMessage(message.key.remoteJid, {
                                            text: 'Gangguan koneksi saat update status order. Silahkan coba lagi!',
                                        })
                                    })
                            } else {
                                if (response.data != null) {
                                    if (response.data.message == 'Order expired') {
                                        wa.sendMessage(message.key.remoteJid, {
                                            text: 'Batas konfirmasi sudah terlewati (1 jam). Silahkan buat pesanan lagi!',
                                        })
                                    }
                                }
                            }
                        })
                        .catch(function (error) {
                            wa.sendMessage(message.key.remoteJid, {
                                text: 'Gangguan koneksi saat cek pesanan terakhir. Silahkan coba lagi!',
                            })
                        })
                } else if (message.message.buttonsResponseMessage.selectedButtonId == 'cancel-order') {
                    //cek tabel order jika (latest create date < 1 jam  dan status = 1) maka cancel ubah status jadi 5
                    axios({
                        method: 'post',
                        url: 'https://api.wangsiap.com/api/orders/get-latest-by-sender',
                        headers: {
                            'Content-Type': 'application/x-www-form-urlencoded',
                        },
                        data: qs.stringify({
                            no_pengirim: splittedRemoteJid[0],
                        }),
                    })
                        .then(function (response) {
                            if (response.data.data != null) {
                                axios({
                                    method: 'post',
                                    url: `https://api.wangsiap.com/api/orders/update-status/${response.data.data.id}`,
                                    headers: {
                                        Accept: 'application/json',
                                        'Content-Type': 'application/x-www-form-urlencoded',
                                    },
                                    data: qs.stringify({
                                        order_status_id: '5',
                                        _method: 'PUT',
                                    }),
                                })
                                    .then(function (response) {
                                        if (response.data.data != null) {
                                            //thank you text harusnya berdasarkan setting user
                                            //conditional jika cod atau transfer
                                            wa.sendMessage(message.key.remoteJid, {
                                                text: 'Pesanan berhasil dibatalkan',
                                            })
                                        }
                                    })
                                    .catch(function (error) {
                                        wa.sendMessage(message.key.remoteJid, {
                                            text: 'Gangguan koneksi saat update status order. Silahkan coba lagi!',
                                        })
                                    })
                            } else {
                                if (response.data != null) {
                                    if (response.data.message == 'Order expired') {
                                        wa.sendMessage(message.key.remoteJid, {
                                            text: 'Batas konfirmasi sudah terlewati (1 jam). Silahkan buat pesanan lagi!',
                                        })
                                    }
                                }
                            }
                        })
                        .catch(function (error) {
                            wa.sendMessage(message.key.remoteJid, {
                                text: 'Gangguan koneksi saat cek pesanan terakhir. Silahkan coba lagi!',
                            })
                        })
                }
            }

            // if (isLegacy) {
            //     await wa.chatRead(message.key, 1)
            // } else {
            //     await wa.sendReadReceipt(message.key.remoteJid, message.key.participant, [message.key.id])
            // }
        }
    })

    wa.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update
        const statusCode = lastDisconnect?.error?.output?.statusCode

        if (connection === 'open') {
            retries.delete(sessionId)
        }

        if (connection === 'close') {
            if (statusCode === DisconnectReason.loggedOut || !shouldReconnect(sessionId)) {
                if (res && !res.headersSent) {
                    response(res, 500, false, 'Unable to create session.')
                }

                return deleteSession(sessionId, isLegacy)
            }

            setTimeout(
                () => {
                    createSession(sessionId, isLegacy, res)
                },
                statusCode === DisconnectReason.restartRequired ? 0 : parseInt(process.env.RECONNECT_INTERVAL ?? 0)
            )
        }

        if (update.qr) {
            if (res && !res.headersSent) {
                try {
                    const qr = await toDataURL(update.qr)

                    response(res, 200, true, 'QR code received, please scan the QR code.', { qr })

                    return
                } catch {
                    response(res, 500, false, 'Unable to create QR code.')
                }
            }

            try {
                await wa.logout()
            } catch {
            } finally {
                deleteSession(sessionId, isLegacy)
            }
        }
    })
}

/**
 * @returns {(import('@adiwajshing/baileys').AnyWASocket|null)}
 */
const getSession = (sessionId) => {
    return sessions.get(sessionId) ?? null
}

const deleteSession = (sessionId, isLegacy = false) => {
    const sessionFile = (isLegacy ? 'legacy_' : 'md_') + sessionId + (isLegacy ? '.json' : '')
    const storeFile = `${sessionId}_store.json`
    const rmOptions = { force: true, recursive: true }

    rmSync(sessionsDir(sessionFile), rmOptions)
    rmSync(sessionsDir(storeFile), rmOptions)

    sessions.delete(sessionId)
    retries.delete(sessionId)
}

const getChatList = (sessionId, isGroup = false) => {
    const filter = isGroup ? '@g.us' : '@s.whatsapp.net'

    return getSession(sessionId).store.chats.filter((chat) => {
        return chat.id.endsWith(filter)
    })
}

/**
 * @param {import('@adiwajshing/baileys').AnyWASocket} session
 */
const isExists = async (session, jid, isGroup = false) => {
    try {
        let result

        if (isGroup) {
            result = await session.groupMetadata(jid)

            return Boolean(result.id)
        }

        if (session.isLegacy) {
            result = await session.onWhatsApp(jid)
        } else {
            ;[result] = await session.onWhatsApp(jid)
        }

        return result.exists
    } catch {
        return false
    }
}

/**
 * @param {import('@adiwajshing/baileys').AnyWASocket} session
 */
const sendMessage = async (session, receiver, message, delayMs = 1000) => {
    try {
        await delay(parseInt(delayMs))

        return session.sendMessage(receiver, message)
    } catch {
        return Promise.reject(null) // eslint-disable-line prefer-promise-reject-errors
    }
}

const formatPhone = (phone) => {
    if (phone.endsWith('@s.whatsapp.net')) {
        return phone
    }

    let formatted = phone.replace(/\D/g, '')

    return (formatted += '@s.whatsapp.net')
}

const formatGroup = (group) => {
    if (group.endsWith('@g.us')) {
        return group
    }

    let formatted = group.replace(/[^\d-]/g, '')

    return (formatted += '@g.us')
}

const cleanup = () => {
    console.log('Running cleanup before exit.')

    sessions.forEach((session, sessionId) => {
        if (!session.isLegacy) {
            session.store.writeToFile(sessionsDir(`${sessionId}_store.json`))
        }
    })
}

const init = () => {
    readdir(sessionsDir(), (err, files) => {
        if (err) {
            throw err
        }

        for (const file of files) {
            if ((!file.startsWith('md_') && !file.startsWith('legacy_')) || file.endsWith('_store')) {
                continue
            }

            const filename = file.replace('.json', '')
            const isLegacy = filename.split('_', 1)[0] !== 'md'
            const sessionId = filename.substring(isLegacy ? 7 : 3)

            createSession(sessionId, isLegacy)
        }
    })
}

export {
    isSessionExists,
    createSession,
    getSession,
    deleteSession,
    getChatList,
    isExists,
    sendMessage,
    formatPhone,
    formatGroup,
    cleanup,
    init,
}
