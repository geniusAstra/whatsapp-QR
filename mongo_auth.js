const { BufferJSON, initAuthCreds, proto } = require('@whiskeysockets/baileys');

module.exports = function useMongoDBAuthState(collection) {
    const writeData = async (data, id) => {
        const jsonStr = JSON.stringify(data, BufferJSON.replacer);
        await collection.updateOne(
            { _id: id },
            { $set: { data: jsonStr } },
            { upsert: true }
        );
    };

    const readData = async (id) => {
        const result = await collection.findOne({ _id: id });
        return result ? JSON.parse(result.data, BufferJSON.reviver) : null;
    };

    const removeData = async (id) => {
        await collection.deleteOne({ _id: id });
    };

    const creds = initAuthCreds();

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(ids.map(async (id) => {
                        let value = await readData(`${type}-${id}`);
                        if (type === 'app-state-sync-key' && value) {
                            value = proto.Message.AppStateSyncKeyData.fromObject(value);
                        }
                        data[id] = value;
                    }));
                    return data;
                },
                set: async (data) => {
                    const tasks = [];
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id];
                            const key = `${category}-${id}`;
                            tasks.push(value ? writeData(value, key) : removeData(key));
                        }
                    }
                    await Promise.all(tasks);
                }
            }
        },
        saveCreds: async () => {
            await writeData(creds, 'creds');
        }
    };
};
