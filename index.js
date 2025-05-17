// Chat Auto Backup 插件 - 自动保存和恢复最近三次聊天记录
// 主要功能：
// 1. 自动保存最近聊天记录到IndexedDB (基于事件触发, 区分立即与防抖)
// 2. 在插件页面显示保存的记录
// 3. 提供恢复功能，将保存的聊天记录恢复到新的聊天中F
// 4. 使用Web Worker优化深拷贝性能

import {
    getContext,
    renderExtensionTemplateAsync,
    extension_settings,
} from '../../../extensions.js';

import {
    // --- 核心应用函数 ---
    saveSettingsDebounced,
    eventSource,
    event_types,
    selectCharacterById,    // 用于选择角色
    doNewChat,              // 用于创建新聊天
    printMessages,          // 用于刷新聊天UI
    scrollChatToBottom,     // 用于滚动到底部
    updateChatMetadata,     // 用于更新聊天元数据
    saveChatConditional,    // 用于保存聊天
    saveChat,               // 用于插件强制保存聊天
    characters,             // 需要访问角色列表来查找索引
    getThumbnailUrl,        // 可能需要获取头像URL（虽然备份里应该有）
    // --- 其他可能需要的函数 ---
    // clearChat, // 可能不需要，doNewChat 应该会处理
    // getCharacters, // 切换角色后可能需要更新？selectCharacterById 内部应该会处理
} from '../../../../script.js';

import {
    // --- 群组相关函数 ---
    select_group_chats,     // 用于选择群组聊天
    // getGroupChat, // 可能不需要，select_group_chats 应该会处理
} from '../../../group-chats.js';

// 扩展名和设置初始化
const PLUGIN_NAME = 'chat-history-backup';
const DEFAULT_SETTINGS = {
    maxTotalBackups: 3,        // 整个系统保留的最大备份数量
    backupDebounceDelay: 1000, // 防抖延迟时间 (毫秒)
    debug: true,               // 调试模式
};

// IndexedDB 数据库名称和版本
const DB_NAME = 'ST_ChatAutoBackup';
const DB_VERSION = 1;
const STORE_NAME = 'backups';

// Web Worker 实例 (稍后初始化)
let backupWorker = null;
// 用于追踪 Worker 请求的 Promise
const workerPromises = {};
let workerRequestId = 0;

// 数据库连接池 - 实现单例模式
let dbConnection = null;

// 备份状态控制
let isBackupInProgress = false; // 并发控制标志
let backupTimeout = null;       // 防抖定时器 ID

// --- 深拷贝逻辑 (将在Worker和主线程中使用) ---
const deepCopyLogicString = `
    const deepCopy = (obj) => {
        try {
            return structuredClone(obj);
        } catch (error) {
            try {
                return JSON.parse(JSON.stringify(obj));
            } catch (jsonError) {
                throw jsonError; // 抛出错误，让主线程知道
            }
        }
    };
`;

// --- 日志函数 ---
function logDebug(...args) {
    const settings = extension_settings[PLUGIN_NAME];
    if (settings && settings.debug) {
        console.log(`[聊天自动备份][${new Date().toLocaleTimeString()}]`, ...args);
    }
}

// --- 设置初始化 ---
function initSettings() {
    console.log('[聊天自动备份] 初始化插件设置');
    if (!extension_settings[PLUGIN_NAME]) {
        console.log('[聊天自动备份] 创建新的插件设置');
        extension_settings[PLUGIN_NAME] = { ...DEFAULT_SETTINGS };
    }

    // 确保设置结构完整
    const settings = extension_settings[PLUGIN_NAME];
    
    // 如果之前使用的是旧版设置，则迁移到新版
    if (settings.hasOwnProperty('maxBackupsPerChat') && !settings.hasOwnProperty('maxTotalBackups')) {
        settings.maxTotalBackups = 3; // 默认值
        delete settings.maxBackupsPerChat; // 移除旧设置
        console.log('[聊天自动备份] 从旧版设置迁移到新版设置');
    }
    
    // 确保所有设置都存在
    settings.maxTotalBackups = settings.maxTotalBackups ?? DEFAULT_SETTINGS.maxTotalBackups;
    settings.backupDebounceDelay = settings.backupDebounceDelay ?? DEFAULT_SETTINGS.backupDebounceDelay;
    settings.debug = settings.debug ?? DEFAULT_SETTINGS.debug;

    // 验证设置合理性
    if (typeof settings.maxTotalBackups !== 'number' || settings.maxTotalBackups < 1) {
        console.log(`[聊天自动备份] 无效的最大备份数 ${settings.maxTotalBackups}，重置为默认值 ${DEFAULT_SETTINGS.maxTotalBackups}`);
        settings.maxTotalBackups = DEFAULT_SETTINGS.maxTotalBackups;
    }
    
    if (typeof settings.backupDebounceDelay !== 'number' || settings.backupDebounceDelay < 300) {
        console.log(`[聊天自动备份] 无效的防抖延迟 ${settings.backupDebounceDelay}，重置为默认值 ${DEFAULT_SETTINGS.backupDebounceDelay}`);
        settings.backupDebounceDelay = DEFAULT_SETTINGS.backupDebounceDelay;
    }

    console.log('[聊天自动备份] 插件设置初始化完成:', settings);
    return settings;
}

// --- IndexedDB 相关函数 (优化版本) ---
// 初始化 IndexedDB 数据库
function initDatabase() {
    return new Promise((resolve, reject) => {
        logDebug('初始化 IndexedDB 数据库');
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onerror = function(event) {
            console.error('[聊天自动备份] 打开数据库失败:', event.target.error);
            reject(event.target.error);
        };

        request.onsuccess = function(event) {
            const db = event.target.result;
            logDebug('数据库打开成功');
            resolve(db);
        };

        request.onupgradeneeded = function(event) {
            const db = event.target.result;
            console.log('[聊天自动备份] 数据库升级中，创建对象存储');
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                const store = db.createObjectStore(STORE_NAME, { keyPath: ['chatKey', 'timestamp'] });
                store.createIndex('chatKey', 'chatKey', { unique: false });
                console.log('[聊天自动备份] 创建了备份存储和索引');
            }
        };
    });
}

// 获取数据库连接 (优化版本 - 使用连接池)
async function getDB() {
    try {
        // 检查现有连接是否可用
        if (dbConnection && dbConnection.readyState !== 'closed') {
            return dbConnection;
        }
        
        // 创建新连接
        dbConnection = await initDatabase();
        return dbConnection;
    } catch (error) {
        console.error('[聊天自动备份] 获取数据库连接失败:', error);
        throw error;
    }
}

// 保存备份到 IndexedDB (优化版本)
async function saveBackupToDB(backup) {
    const db = await getDB();
    try {
        await new Promise((resolve, reject) => {
            const transaction = db.transaction([STORE_NAME], 'readwrite');
            
            transaction.oncomplete = () => {
                logDebug(`备份已保存到IndexedDB, 键: [${backup.chatKey}, ${backup.timestamp}]`);
                resolve();
            };
            
            transaction.onerror = (event) => {
                console.error('[聊天自动备份] 保存备份事务失败:', event.target.error);
                reject(event.target.error);
            };
            
            const store = transaction.objectStore(STORE_NAME);
            store.put(backup);
        });
    } catch (error) {
        console.error('[聊天自动备份] saveBackupToDB 失败:', error);
        throw error;
    }
}

// 从 IndexedDB 获取指定聊天的所有备份 (优化版本)
async function getBackupsForChat(chatKey) {
    const db = await getDB();
    try {
        return await new Promise((resolve, reject) => {
            const transaction = db.transaction([STORE_NAME], 'readonly');
            
            transaction.onerror = (event) => {
                console.error('[聊天自动备份] 获取备份事务失败:', event.target.error);
                reject(event.target.error);
            };
            
            const store = transaction.objectStore(STORE_NAME);
            const index = store.index('chatKey');
            const request = index.getAll(chatKey);
            
            request.onsuccess = () => {
                const backups = request.result || [];
                logDebug(`从IndexedDB获取了 ${backups.length} 个备份，chatKey: ${chatKey}`);
                resolve(backups);
            };
            
            request.onerror = (event) => {
                console.error('[聊天自动备份] 获取备份失败:', event.target.error);
                reject(event.target.error);
            };
        });
    } catch (error) {
        console.error('[聊天自动备份] getBackupsForChat 失败:', error);
        return []; // 出错时返回空数组
    }
}

// 从 IndexedDB 获取所有备份 (优化版本)
async function getAllBackups() {
    const db = await getDB();
    try {
        return await new Promise((resolve, reject) => {
            const transaction = db.transaction([STORE_NAME], 'readonly');
            
            transaction.onerror = (event) => {
                console.error('[聊天自动备份] 获取所有备份事务失败:', event.target.error);
                reject(event.target.error);
            };
            
            const store = transaction.objectStore(STORE_NAME);
            const request = store.getAll();
            
            request.onsuccess = () => {
                const backups = request.result || [];
                logDebug(`从IndexedDB获取了总共 ${backups.length} 个备份`);
                resolve(backups);
            };
            
            request.onerror = (event) => {
                console.error('[聊天自动备份] 获取所有备份失败:', event.target.error);
                reject(event.target.error);
            };
        });
    } catch (error) {
        console.error('[聊天自动备份] getAllBackups 失败:', error);
        return [];
    }
}

// 从 IndexedDB 获取所有备份的主键 (优化清理逻辑)
async function getAllBackupKeys() {
    const db = await getDB();
    try {
        return await new Promise((resolve, reject) => {
            const transaction = db.transaction([STORE_NAME], 'readonly');

            transaction.onerror = (event) => {
                console.error('[聊天自动备份] 获取所有备份键事务失败:', event.target.error);
                reject(event.target.error);
            };

            const store = transaction.objectStore(STORE_NAME);
            // 使用 getAllKeys() 只获取主键
            const request = store.getAllKeys();

            request.onsuccess = () => {
                // 返回的是键的数组，每个键是 [chatKey, timestamp]
                const keys = request.result || [];
                logDebug(`从IndexedDB获取了总共 ${keys.length} 个备份的主键`);
                resolve(keys);
            };

            request.onerror = (event) => {
                console.error('[聊天自动备份] 获取所有备份键失败:', event.target.error);
                reject(event.target.error);
            };
        });
    } catch (error) {
        console.error('[聊天自动备份] getAllBackupKeys 失败:', error);
        return []; // 出错时返回空数组
    }
} 

// 从 IndexedDB 删除指定备份 (优化版本)
async function deleteBackup(chatKey, timestamp) {
    const db = await getDB();
    try {
        await new Promise((resolve, reject) => {
            const transaction = db.transaction([STORE_NAME], 'readwrite');
            
            transaction.oncomplete = () => {
                logDebug(`已从IndexedDB删除备份, 键: [${chatKey}, ${timestamp}]`);
                resolve();
            };
            
            transaction.onerror = (event) => {
                console.error('[聊天自动备份] 删除备份事务失败:', event.target.error);
                reject(event.target.error);
            };
            
            const store = transaction.objectStore(STORE_NAME);
            store.delete([chatKey, timestamp]);
        });
    } catch (error) {
        console.error('[聊天自动备份] deleteBackup 失败:', error);
        throw error;
    }
}

// --- 聊天信息获取 (保持不变) ---
function getCurrentChatKey() {
    const context = getContext();
    logDebug('获取当前聊天标识符, context:',
        {groupId: context.groupId, characterId: context.characterId, chatId: context.chatId});
    if (context.groupId) {
        const key = `group_${context.groupId}_${context.chatId}`;
        logDebug('当前是群组聊天，chatKey:', key);
        return key;
    } else if (context.characterId !== undefined && context.chatId) { // 确保chatId存在
        const key = `char_${context.characterId}_${context.chatId}`;
        logDebug('当前是角色聊天，chatKey:', key);
        return key;
    }
    console.warn('[聊天自动备份] 无法获取当前聊天的有效标识符 (可能未选择角色/群组或聊天)');
    return null;
}

function getCurrentChatInfo() {
    const context = getContext();
    let chatName = '当前聊天', entityName = '未知';

    if (context.groupId) {
        const group = context.groups?.find(g => g.id === context.groupId);
        entityName = group ? group.name : `群组 ${context.groupId}`;
        chatName = context.chatId || '新聊天'; // 使用更明确的默认名
        logDebug('获取到群组聊天信息:', {entityName, chatName});
    } else if (context.characterId !== undefined) {
        entityName = context.name2 || `角色 ${context.characterId}`;
        const character = context.characters?.[context.characterId];
        if (character && context.chatId) {
             // chat文件名可能包含路径，只取最后一部分
             const chatFile = character.chat || context.chatId;
             chatName = chatFile.substring(chatFile.lastIndexOf('/') + 1).replace('.jsonl', '');
        } else {
            chatName = context.chatId || '新聊天';
        }
        logDebug('获取到角色聊天信息:', {entityName, chatName});
    } else {
        console.warn('[聊天自动备份] 无法获取聊天实体信息，使用默认值');
    }

    return { entityName, chatName };
}

// --- Web Worker 通信 ---
// 发送数据到 Worker 并返回包含拷贝后数据的 Promise
function performDeepCopyInWorker(chat, metadata) {
    return new Promise((resolve, reject) => {
        if (!backupWorker) {
            return reject(new Error("Backup worker not initialized."));
        }

        const currentRequestId = ++workerRequestId;
        workerPromises[currentRequestId] = { resolve, reject };

        logDebug(`[主线程] 发送数据到 Worker (ID: ${currentRequestId}), Chat长度: ${chat?.length}`);
        try {
             // 只发送需要拷贝的数据，减少序列化开销
            backupWorker.postMessage({
                id: currentRequestId,
                payload: { chat, metadata }
            });
        } catch (error) {
             console.error(`[主线程] 发送消息到 Worker 失败 (ID: ${currentRequestId}):`, error);
             delete workerPromises[currentRequestId];
             reject(error);
        }
    });
}

// --- 核心备份逻辑封装 (接收具体数据) ---
async function executeBackupLogic_Core(chat, chat_metadata_to_backup, settings) {
    const currentTimestamp = Date.now();
    logDebug(`(封装) 开始执行核心备份逻辑 @ ${new Date(currentTimestamp).toLocaleTimeString()}`);

    // 1. 前置检查 (使用传入的数据，而不是 getContext())
    const chatKey = getCurrentChatKey(); // 这个仍然需要获取当前的chatKey
    if (!chatKey) {
        console.warn('[聊天自动备份] (封装) 无有效的聊天标识符');
        return false;
    }

    const { entityName, chatName } = getCurrentChatInfo();
    const lastMsgIndex = chat.length - 1;
    const lastMessage = chat[lastMsgIndex];
    const lastMessagePreview = lastMessage?.mes?.substring(0, 100) || '(空消息)';

    logDebug(`(封装) 准备备份聊天: ${entityName} - ${chatName}, 消息数: ${chat.length}, 最后消息ID: ${lastMsgIndex}`);
    // *** 打印传入的元数据状态进行调试 ***
    logDebug(`(封装) 备份的 metadata 状态:`, chat_metadata_to_backup);

    try {
        // 2. 使用 Worker 进行深拷贝 (使用传入的 chat 和 chat_metadata_to_backup)
        let copiedChat, copiedMetadata;
        if (backupWorker) {
            try {
                console.time('[聊天自动备份] Web Worker 深拷贝时间');
                logDebug('(封装) 请求 Worker 执行深拷贝...');
                const result = await performDeepCopyInWorker(chat, chat_metadata_to_backup); // 使用传入的数据
                copiedChat = result.chat;
                copiedMetadata = result.metadata;
                console.timeEnd('[聊天自动备份] Web Worker 深拷贝时间');
                logDebug('(封装) 从 Worker 收到拷贝后的数据');
            } catch(workerError) {
                 // ... 主线程回退逻辑，使用传入的 chat 和 chat_metadata_to_backup ...
                 console.error('[聊天自动备份] (封装) Worker 深拷贝失败，将尝试在主线程执行:', workerError);
                  console.time('[聊天自动备份] 主线程深拷贝时间 (Worker失败后)');
                  try {
                      copiedChat = structuredClone(chat);
                      copiedMetadata = structuredClone(chat_metadata_to_backup); // 使用传入的数据
                  } catch (structuredCloneError) {
                     try {
                         copiedChat = JSON.parse(JSON.stringify(chat));
                         copiedMetadata = JSON.parse(JSON.stringify(chat_metadata_to_backup)); // 使用传入的数据
                     } catch (jsonError) {
                         console.error('[聊天自动备份] (封装) 主线程深拷贝也失败:', jsonError);
                         throw new Error("无法完成聊天数据的深拷贝");
                     }
                  }
                  console.timeEnd('[聊天自动备份] 主线程深拷贝时间 (Worker失败后)');
            }
        } else {
            // Worker 不可用，直接在主线程执行 (使用传入的 chat 和 chat_metadata_to_backup)
            console.time('[聊天自动备份] 主线程深拷贝时间 (无Worker)');
             try {
                 copiedChat = structuredClone(chat);
                 copiedMetadata = structuredClone(chat_metadata_to_backup); // 使用传入的数据
             } catch (structuredCloneError) {
                try {
                    copiedChat = JSON.parse(JSON.stringify(chat));
                    copiedMetadata = JSON.parse(JSON.stringify(chat_metadata_to_backup)); // 使用传入的数据
                } catch (jsonError) {
                    console.error('[聊天自动备份] (封装) 主线程深拷贝失败:', jsonError);
                    throw new Error("无法完成聊天数据的深拷贝");
                }
             }
            console.timeEnd('[聊天自动备份] 主线程深拷贝时间 (无Worker)');
        }

        if (!copiedChat) {
             throw new Error("未能获取有效的聊天数据副本");
        }

        // 3. 构建备份对象
        const backup = {
            timestamp: currentTimestamp,
            chatKey,
            entityName,
            chatName,
            lastMessageId: lastMsgIndex,
            lastMessagePreview,
            chat: copiedChat,
            metadata: copiedMetadata || {} // 确保 metadata 总是对象
        };

        // 4. 检查当前聊天是否已有基于最后消息ID的备份 (避免完全相同的备份)
        const existingBackups = await getBackupsForChat(chatKey); // 获取当前聊天的备份

        // 5. 检查重复并处理 (基于 lastMessageId)
        const existingBackupIndex = existingBackups.findIndex(b => b.lastMessageId === lastMsgIndex);
        let needsSave = true;

        if (existingBackupIndex !== -1) {
             // 如果找到相同 lastMessageId 的备份
            const existingTimestamp = existingBackups[existingBackupIndex].timestamp;
            if (backup.timestamp > existingTimestamp) {
                // 新备份更新，删除旧的同 ID 备份
                logDebug(`(封装) 发现具有相同最后消息ID (${lastMsgIndex}) 的旧备份 (时间戳 ${existingTimestamp})，将删除旧备份以便保存新备份 (时间戳 ${backup.timestamp})`);
                await deleteBackup(chatKey, existingTimestamp);
                // 注意：不需要从 existingBackups 数组中 splice，因为它不再用于全局清理
            } else {
                // 旧备份更新或相同，跳过本次保存
                logDebug(`(封装) 发现具有相同最后消息ID (${lastMsgIndex}) 且时间戳更新或相同的备份 (时间戳 ${existingTimestamp} vs ${backup.timestamp})，跳过本次保存`);
                needsSave = false;
            }
        }

        if (!needsSave) {
            logDebug('(封装) 备份已存在或无需更新 (基于lastMessageId和时间戳比较)，跳过保存和全局清理步骤');
            return false; // 不需要保存，返回 false
        }

        // 6. 保存新备份到 IndexedDB
        await saveBackupToDB(backup);
        logDebug(`(封装) 新备份已保存: [${chatKey}, ${backup.timestamp}]`);

        // --- 优化后的清理逻辑 ---
        // 7. 获取所有备份的 *主键* 并限制总数量
        logDebug(`(封装) 获取所有备份的主键，以检查是否超出系统限制 (${settings.maxTotalBackups})`);
        const allBackupKeys = await getAllBackupKeys(); // 调用新函数，只获取键

        if (allBackupKeys.length > settings.maxTotalBackups) {
            logDebug(`(封装) 总备份数 (${allBackupKeys.length}) 超出系统限制 (${settings.maxTotalBackups})`);

            // 按时间戳升序排序键 (key[1] 是 timestamp)
            // 这样最旧的备份的键会排在数组前面
            allBackupKeys.sort((a, b) => a[1] - b[1]); // a[1] = timestamp, b[1] = timestamp

            const numToDelete = allBackupKeys.length - settings.maxTotalBackups;
            // 获取数组开头的 numToDelete 个键，这些是需要删除的最旧备份的键
            const keysToDelete = allBackupKeys.slice(0, numToDelete);

            logDebug(`(封装) 准备删除 ${keysToDelete.length} 个最旧的备份 (基于键)`);

            // 使用Promise.all并行删除
            await Promise.all(keysToDelete.map(key => {
                const oldChatKey = key[0];
                const oldTimestamp = key[1];
                logDebug(`(封装) 删除旧备份 (基于键): chatKey=${oldChatKey}, timestamp=${new Date(oldTimestamp).toLocaleString()}`);
                // 调用 deleteBackup，它接受 chatKey 和 timestamp
                return deleteBackup(oldChatKey, oldTimestamp);
            }));
            logDebug(`(封装) ${keysToDelete.length} 个旧备份已删除`);
        } else {
            logDebug(`(封装) 总备份数 (${allBackupKeys.length}) 未超出限制 (${settings.maxTotalBackups})，无需清理`);
        }
        // --- 清理逻辑结束 ---

        // 8. UI提示
        logDebug(`(封装) 成功完成聊天备份及可能的清理: ${entityName} - ${chatName}`);

        return true; // 表示备份成功（或已跳过但无错误）

    } catch (error) {
        console.error('[聊天自动备份] (封装) 备份或清理过程中发生严重错误:', error);
        throw error; // 抛出错误，让外部调用者处理提示
    }
}

// --- 条件备份函数 (使用getcontext获取) ---
async function performBackupConditional() {
    if (isBackupInProgress) {
        logDebug('备份已在进行中，跳过本次请求');
        return false;
    }

    const currentSettings = extension_settings[PLUGIN_NAME];
    if (!currentSettings) {
        console.error('[聊天自动备份] 无法获取当前设置，取消备份');
        return false;
    }

    logDebug('执行条件备份 (performBackupConditional)');
    clearTimeout(backupTimeout);
    backupTimeout = null;

    const context = getContext();
    const chatKey = getCurrentChatKey();

    // 检查基本上下文和 chatMetadata 是否存在
    if (!chatKey || !context || !context.chatMetadata) {
        console.warn('[聊天自动备份] 无法获取有效的聊天标识符或 chatMetadata，取消备份');
        logDebug('[聊天自动备份] Cancellation Details:', {
             chatKey: chatKey,
             contextDefined: !!context,
             chatMetadataDefined: !!context?.chatMetadata
         });
        return false;
    }

    // 直接获取当前状态的 chat 和 metadata 进行备份
    const chat = context.chat;
    const chat_metadata_to_backup = context.chatMetadata; // 直接使用当前的 chatMetadata

    // 检查 sheets，但只警告，不取消
    if (!chat_metadata_to_backup.sheets || !Array.isArray(chat_metadata_to_backup.sheets) || chat_metadata_to_backup.sheets.length === 0) {
         console.warn('[聊天自动备份] chatMetadata.sheets 无效或为空。备份将继续，但表格数据可能不完整或丢失。');
         logDebug('[聊天自动备份] Sheets Cancellation Details (Warning Only):', {
             sheetsDefined: !!chat_metadata_to_backup?.sheets,
             isSheetsArray: Array.isArray(chat_metadata_to_backup?.sheets),
             sheetsLength: chat_metadata_to_backup?.sheets?.length
         });
    }


    isBackupInProgress = true;
    logDebug('设置备份锁');
    try {
        // 使用直接获取的 chat 和 metadata 进行备份
        const success = await executeBackupLogic_Core(chat, chat_metadata_to_backup, currentSettings); // 传递直接获取的 metadata
        if (success) {
            await updateBackupsList();
        }
        return success;
    } catch (error) {
        console.error('[聊天自动备份] 条件备份执行失败:', error);
        toastr.error(`备份失败: ${error.message || '未知错误'}`, '聊天自动备份');
        return false;
    } finally {
        isBackupInProgress = false;
        logDebug('释放备份锁');
    }
}

// --- 防抖备份函数 (类似 saveChatDebounced) ---
function performBackupDebounced() {
    // 获取调用时的上下文和设置
    const scheduledChatKey = getCurrentChatKey();
    const currentSettings = extension_settings[PLUGIN_NAME];

    if (!scheduledChatKey) {
        logDebug('无法获取计划防抖备份时的 ChatKey，取消');
        clearTimeout(backupTimeout);
        backupTimeout = null;
        return;
    }
    
    if (!currentSettings || typeof currentSettings.backupDebounceDelay !== 'number') {
        console.error('[聊天自动备份] 无法获取有效的防抖延迟设置，取消防抖');
        clearTimeout(backupTimeout);
        backupTimeout = null;
        return;
    }
    
    const delay = currentSettings.backupDebounceDelay; // 使用当前设置的延迟

    logDebug(`计划执行防抖备份 (延迟 ${delay}ms), 针对 ChatKey: ${scheduledChatKey}`);
    clearTimeout(backupTimeout); // 清除旧的定时器

    backupTimeout = setTimeout(async () => {
        const currentChatKey = getCurrentChatKey(); // 获取执行时的 ChatKey

        // 关键: 上下文检查
        if (currentChatKey !== scheduledChatKey) {
            logDebug(`上下文已更改 (当前: ${currentChatKey}, 计划时: ${scheduledChatKey})，取消此防抖备份`);
            backupTimeout = null;
            return; // 中止备份
        }

        logDebug(`执行延迟的备份操作 (来自防抖), ChatKey: ${currentChatKey}`);
        // 只有上下文匹配时才执行条件备份
        await performBackupConditional();
        backupTimeout = null; // 清除定时器 ID
    }, delay);
}

// --- 手动备份 ---
async function performManualBackup() {
    console.log('[聊天自动备份] 执行手动备份 (调用条件函数)');
    await performBackupConditional(); // 手动备份也走条件检查和锁逻辑
    toastr.success('已手动备份当前聊天', '聊天自动备份');
}

// --- 恢复逻辑 ---
// index.js (内部的 restoreBackup 函数 - 审查和优化)
async function restoreBackup(backupData) {
    // --- 入口与基本信息提取 ---
    console.log('[聊天自动备份] 开始恢复备份:', { chatKey: backupData.chatKey, timestamp: backupData.timestamp });
    logDebug('[聊天自动备份] 原始备份数据 (备份):', JSON.parse(JSON.stringify(backupData))); // 新增日志：打印原始备份数据

    const isGroup = backupData.chatKey.startsWith('group_');
    const entityIdMatch = backupData.chatKey.match(
        isGroup
        ? /group_(\w+)_/ // 匹配群组ID
        : /^char_(\d+)/  // 匹配角色ID (索引)
    );
    let entityId = entityIdMatch ? entityIdMatch[1] : null;
    let targetCharIndex = -1; // 保存角色索引，以便稍后切回

    if (!entityId) {
        console.error('[聊天自动备份] 无法从备份数据中提取角色/群组ID:', backupData.chatKey);
        toastr.error('无法识别备份对应的角色/群组ID');
        return false;
    }

    logDebug(`恢复目标: ${isGroup ? '群组' : '角色'} ID/标识: ${entityId}`);

    // *** 保存当前选中的实体 ID 和类型，以便最后切回 ***
    const entityToRestore = {
        isGroup: isGroup,
        id: entityId,
        charIndex: -1 // 初始化
    };
    if (!isGroup) {
        entityToRestore.charIndex = parseInt(entityId, 10);
        if (isNaN(entityToRestore.charIndex) || entityToRestore.charIndex < 0 || entityToRestore.charIndex >= characters.length) {
             console.error(`[聊天自动备份] 角色索引无效: ${entityId}`);
             toastr.error(`无效的角色索引 ${entityId}`);
             return false;
        }
    }

    try {
        // --- 步骤 1: 切换上下文 --- (如果当前不是目标，则切换；如果已经是，则跳过)
        const initialContext = getContext();
        logDebug('[聊天自动备份] 步骤 1 - 切换前上下文:', { // <-- 记录切换前状态
            groupId: initialContext.groupId,
            characterId: initialContext.characterId,
            chatId: initialContext.chatId
        });
        const needsContextSwitch = (isGroup && initialContext.groupId !== entityId) ||
                                   (!isGroup && String(initialContext.characterId) !== entityId);

        if (needsContextSwitch) {
            try {
                logDebug('步骤 1: 需要切换上下文，开始切换...');
                if (isGroup) {
                    await select_group_chats(entityId);
                } else {
                    await selectCharacterById(entityToRestore.charIndex, { switchMenu: false });
                }
                // **关键延迟点 1.5：在切换角色/群组后增加延迟**
                // 此时 SillyTavern 会触发 CHAT_CHANGED，给表格插件一点时间处理（即使会报错）
                console.log('[聊天自动备份] 步骤 1.5: 切换上下文后增加短暂延迟...');
                await new Promise(resolve => setTimeout(resolve, 500)); // 增加延迟，例如 500ms
                console.log('[聊天自动备份] 步骤 1.5: 延迟结束。当前上下文:', {
                    groupId: getContext().groupId,
                    characterId: getContext().characterId,
                    chatId: getContext().chatId
                });
            } catch (switchError) {
                console.error('[聊天自动备份] 步骤 1 失败: 切换角色/群组失败:', switchError);
                toastr.error(`切换上下文失败: ${switchError.message || switchError}`);
                return false;
            }
        } else {
            logDebug('步骤 1: 当前已在目标上下文，跳过切换');
        }


        // --- 步骤 2: 创建新聊天 ---
        let originalChatIdBeforeNewChat = getContext().chatId;
        logDebug('步骤 2: 开始创建新聊天...');
        await doNewChat({ deleteCurrentChat: false });
         // **关键延迟点 2.5：在创建新聊天后增加延迟**
         // 此时 SillyTavern 会再次触发 CHAT_CHANGED
        console.log('[聊天自动备份] 步骤 2.5: 创建新聊天后增加短暂延迟...');
        await new Promise(resolve => setTimeout(resolve, 1000)); // 增加延迟，例如 1000ms
        console.log('[聊天自动备份] 步骤 2.5: 延迟结束');


        // --- 步骤 3: 获取新聊天 ID ---
        logDebug('步骤 3: 获取新聊天 ID...');
        let contextAfterNewChat = getContext();
        const newChatId = contextAfterNewChat.chatId;

        if (!newChatId || newChatId === originalChatIdBeforeNewChat) {
            console.error('[聊天自动备份] 步骤 3 失败: 未能获取有效的新 chatId。 新ChatID:', newChatId, "旧ChatID:", originalChatIdBeforeNewChat);
            toastr.error('未能获取新聊天的ID，无法继续恢复');
            return false;
        }
        logDebug(`步骤 3: 新聊天ID: ${newChatId}`);

        // --- 步骤 4: 准备聊天内容和元数据 ---
        logDebug('步骤 4: 准备内存中的聊天内容和元数据...');
        const chatToSave = structuredClone(backupData.chat);
        // **修正：确保恢复的是 metadata，而不是空对象 {}**
        let metadataToSave = structuredClone(backupData.metadata || {}); // 使用备份中的 metadata
        console.log('[聊天自动备份] 步骤 4 - 待保存的聊天消息 (前两条):', chatToSave.slice(0, Math.min(chatToSave.length, 2)));
        console.log('[聊天自动备份] 步骤 4 - 待保存的元数据:', JSON.parse(JSON.stringify(metadataToSave)));

        // 特别检查表格相关的元数据
        if (metadataToSave.sheets) {
            console.log('[聊天自动备份] 步骤 4 - 恢复的元数据中包含表格定义 (sheets):', JSON.parse(JSON.stringify(metadataToSave.sheets)));
        } else {
            console.warn('[聊天自动备份] 步骤 4 - 警告：恢复的元数据中【不包含】表格定义 (sheets)！');
        }

        logDebug(`步骤 4: 准备完成, 消息数: ${chatToSave.length}, 元数据:`, JSON.parse(JSON.stringify(metadataToSave)));

        // --- 步骤 5: 保存恢复的数据到新聊天文件 ---
        logDebug(`步骤 5: 临时替换全局 chat 和 chatMetadata 以便保存...`);
        let globalContext = getContext();
        let originalGlobalChat = globalContext.chat.slice();
        // 备份当前的 chatMetadata
        let originalGlobalMetadata = structuredClone(globalContext.chatMetadata);
        console.log('[聊天自动备份] 步骤 5 - 保存前的全局 chatMetadata:', JSON.parse(JSON.stringify(originalGlobalMetadata)));

        globalContext.chat.length = 0;
        chatToSave.forEach(msg => globalContext.chat.push(msg));
        // **关键：直接替换 chatMetadata，绕过表格插件的 Proxy**
        globalContext.chatMetadata = metadataToSave;
        console.log('[聊天自动备份] 步骤 5 - 全局 chatMetadata 已被恢复的元数据替换 (直接赋值):', JSON.parse(JSON.stringify(globalContext.chatMetadata)));
        // 再次确认 sheets 状态
        if (globalContext.chatMetadata && globalContext.chatMetadata.sheets) {
             console.log('[聊天自动备份] 步骤 5 - 直接赋值后，全局 chatMetadata.sheets:', JSON.parse(JSON.stringify(globalContext.chatMetadata.sheets)));
        } else {
             console.warn('[聊天自动备份] 步骤 5 - 警告：直接赋值后，全局 chatMetadata.sheets 未找到或为空！');
        }


        logDebug(`步骤 5: 即将调用 saveChat({ chatName: ${newChatId}, force: true }) 保存恢复的数据...`);
        try {
            await saveChat({ chatName: newChatId, force: true });
            logDebug('步骤 5: saveChat 调用完成');
             // **关键延迟点 5.5：在 saveChat 后增加短暂延迟，确保文件写入完成**
            console.log('[聊天自动备份] 步骤 5.5: saveChat 后增加短暂延迟...');
            await new Promise(resolve => setTimeout(resolve, 200)); // 增加延迟，例如 200ms
            console.log('[聊天自动备份] 步骤 5.5: 延迟结束');
        } catch (saveError) {
            console.error("[聊天自动备份] 步骤 5 失败: saveChat 调用时出错:", saveError);
            toastr.error(`保存恢复的聊天失败: ${saveError.message}`, '聊天自动备份');
            // 恢复状态 (使用直接赋值)
            globalContext.chat.length = 0;
            originalGlobalChat.forEach(msg => globalContext.chat.push(msg));
            globalContext.chatMetadata = originalGlobalMetadata; // 恢复
            console.warn('[聊天自动备份] 步骤 5 - saveChat 失败后，全局状态已恢复 (直接赋值)。');
            return false;
        } finally {
             // 恢复状态 (使用直接赋值)
             globalContext.chat.length = 0;
             originalGlobalChat.forEach(msg => globalContext.chat.push(msg));
             globalContext.chatMetadata = originalGlobalMetadata; // 恢复
             logDebug('步骤 5: 全局 chat 和 chatMetadata 已恢复到保存前状态 (直接赋值)');
        }

        // --- 步骤 6: 强制重加载 - 通过关闭再打开 ---
        console.log('[聊天自动备份] 步骤 6: 开始强制重加载流程 (关闭再打开)...');
        try {
            // 6a: 触发关闭聊天 (模拟点击)
            console.log("[聊天自动备份] 步骤 6a: 触发 '关闭聊天'");
            const closeButton = document.getElementById('option_close_chat');
            if (closeButton) closeButton.click();
            else console.warn("[聊天自动备份] 未能找到 #option_close_chat 按钮");
            await new Promise(resolve => setTimeout(resolve, 800)); // 等待关闭动画/状态更新

            // 6b: 触发重新选择目标实体 (这会触发新的 CHAT_CHANGED 事件，并从文件加载 chatMetadata)
            console.log(`[聊天自动备份] 步骤 6b: 重新选择目标实体 ID: ${entityToRestore.id}`);
            if (entityToRestore.isGroup) {
                await select_group_chats(entityToRestore.id);
            } else {
                // 依赖 SillyTavern 重新选择角色后加载最新或指定聊天
                 await selectCharacterById(entityToRestore.charIndex, { switchMenu: false });
            }
            // await new Promise(resolve => setTimeout(resolve, 1000)); // 移除或减少这个延迟，因为下面的关键延迟更重要

            console.log('[聊天自动备份] 步骤 6: 关闭再打开流程完成');
             // **关键延迟点 6.5 (最重要延迟)：在关闭再打开、UI加载后，给表格插件处理最终 CHAT_CHANGED 的时间**
            console.log('[聊天自动备份] 步骤 6.5: 关闭再打开后等待一段时间，确保环境稳定...');
            // 尝试一个比较大的延迟，例如 2秒 或 3秒，看看 ReferenceError 是否消失
            await new Promise(resolve => setTimeout(resolve, 2000));
            console.log('[聊天自动备份] 步骤 6.5: 延迟结束。当前上下文:', {
                groupId: getContext().groupId,
                characterId: getContext().characterId,
                chatId: getContext().chatId,
                chatMetadata: getContext().chatMetadata ? '...' : 'undefined'
            });
            // **新增日志：再次检查加载后的 chatMetadata.sheets**
            const loadedContext = getContext();
            if (loadedContext.chatMetadata && loadedContext.chatMetadata.sheets) {
                console.log('[聊天自动备份] 步骤 6.5 - 延迟后，当前聊天的表格定义 (sheets) (从文件加载):', JSON.parse(JSON.stringify(loadedContext.chatMetadata.sheets)));
            } else {
                 console.warn('[聊天自动备份] 步骤 6.5 - 警告：延迟后，当前聊天的表格定义 (sheets) (从文件加载) 未找到或为空！这可能表明文件未正确加载或保存。');
            }


        } catch (reloadError) {
            console.error('[聊天自动备份] 步骤 6 失败:', reloadError);
            toastr.error('重新加载恢复的聊天内容失败，请尝试手动切换聊天。数据已保存。');
            // 即使加载失败，也尝试触发事件，让其他插件有机会反应
            console.log('[聊天自动备份] 步骤 6 - 强制重加载失败，尝试触发 CHAT_CHANGED...');
            const finalContextAfterError = getContext();
            eventSource.emit(event_types.CHAT_CHANGED, finalContextAfterError.chatId);
        }

        // --- 步骤 7: 触发事件 ---
        // (依赖步骤 6b 触发的事件，这里不再手动触发，避免重复和潜在的时序问题)
        //logDebug('步骤 7: 触发 CHAT_CHANGED 事件...'); // 移除或注释掉这行和下面的 emit
        //const finalContext = getContext();
        //eventSource.emit(event_types.CHAT_CHANGED, finalContext.chatId);

        // --- 结束 ---
        console.log('[聊天自动备份] 恢复流程完成');
        return true;

    } catch (error) {
        console.error('[聊天自动备份] 恢复聊天过程中发生未预料的严重错误:', error);
        toastr.error(`恢复失败: ${error.message || '未知错误'}`, '聊天自动备份');
        return false;
    }
}

// --- UI 更新 ---
async function updateBackupsList() {
    console.log('[聊天自动备份] 开始更新备份列表UI');
    const backupsContainer = $('#chat_backup_list');
    if (!backupsContainer.length) {
        console.warn('[聊天自动备份] 找不到备份列表容器元素 #chat_backup_list');
        return;
    }

    backupsContainer.html('<div class="backup_empty_notice">正在加载备份...</div>');

    try {
        const allBackups = await getAllBackups();
        backupsContainer.empty(); // 清空

        if (allBackups.length === 0) {
            backupsContainer.append('<div class="backup_empty_notice">暂无保存的备份</div>');
            return;
        }

        // 按时间降序排序
        allBackups.sort((a, b) => b.timestamp - a.timestamp);
        logDebug(`渲染 ${allBackups.length} 个备份`);

        allBackups.forEach(backup => {
            const date = new Date(backup.timestamp);
            // 使用更可靠和本地化的格式
            const formattedDate = date.toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'medium' });

            const backupItem = $(`
                <div class="backup_item">
                    <div class="backup_info">
                        <div class="backup_header">
                            <span class="backup_entity" title="${backup.entityName}">${backup.entityName || '未知实体'}</span>
                            <span class="backup_chat" title="${backup.chatName}">${backup.chatName || '未知聊天'}</span>
                        </div>
                         <div class="backup_details">
                            <span class="backup_mesid">消息数: ${backup.lastMessageId + 1}</span>
                            <span class="backup_date">${formattedDate}</span>
                        </div>
                        <div class="backup_preview" title="${backup.lastMessagePreview}">${backup.lastMessagePreview}...</div>
                    </div>
                    <div class="backup_actions">
                        <button class="menu_button backup_preview_btn" title="预览此备份的最后两条消息" data-timestamp="${backup.timestamp}" data-key="${backup.chatKey}">预览</button>
                        <button class="menu_button backup_restore" title="恢复此备份到新聊天" data-timestamp="${backup.timestamp}" data-key="${backup.chatKey}">恢复</button>
                        <button class="menu_button danger_button backup_delete" title="删除此备份" data-timestamp="${backup.timestamp}" data-key="${backup.chatKey}">删除</button>
                    </div>
                </div>
            `);
            backupsContainer.append(backupItem);
        });

        console.log('[聊天自动备份] 备份列表渲染完成');
    } catch (error) {
        console.error('[聊天自动备份] 更新备份列表失败:', error);
        backupsContainer.html(`<div class="backup_empty_notice">加载备份列表失败: ${error.message}</div>`);
    }
}

// --- 初始化与事件绑定 ---
jQuery(async () => {
    console.log('[聊天自动备份] 插件加载中...');

    // 初始化设置
    const settings = initSettings();

    try {
        // 初始化数据库
        await initDatabase();

        // --- 创建 Web Worker ---
        try {
             // 定义 Worker 内部代码
            const workerCode = `
                // Worker Scope
                ${deepCopyLogicString} // 注入深拷贝函数

                self.onmessage = function(e) {
                    const { id, payload } = e.data;
                    // console.log('[Worker] Received message with ID:', id);
                    if (!payload) {
                         // console.error('[Worker] Invalid payload received');
                         self.postMessage({ id, error: 'Invalid payload received by worker' });
                         return;
                    }
                    try {
                        const copiedChat = payload.chat ? deepCopy(payload.chat) : null;
                        const copiedMetadata = payload.metadata ? deepCopy(payload.metadata) : null;
                        // console.log('[Worker] Deep copy successful for ID:', id);
                        self.postMessage({ id, result: { chat: copiedChat, metadata: copiedMetadata } });
                    } catch (error) {
                        // console.error('[Worker] Error during deep copy for ID:', id, error);
                        self.postMessage({ id, error: error.message || 'Worker deep copy failed' });
                    }
                };
            `;
            const blob = new Blob([workerCode], { type: 'application/javascript' });
            backupWorker = new Worker(URL.createObjectURL(blob));
            console.log('[聊天自动备份] Web Worker 已创建');

            // 设置 Worker 消息处理器 (主线程)
            backupWorker.onmessage = function(e) {
                const { id, result, error } = e.data;
                // logDebug(`[主线程] 从 Worker 收到消息 (ID: ${id})`);
                if (workerPromises[id]) {
                    if (error) {
                        console.error(`[主线程] Worker 返回错误 (ID: ${id}):`, error);
                        workerPromises[id].reject(new Error(error));
                    } else {
                        // logDebug(`[主线程] Worker 返回结果 (ID: ${id})`);
                        workerPromises[id].resolve(result);
                    }
                    delete workerPromises[id]; // 清理 Promise 记录
                } else {
                     console.warn(`[主线程] 收到未知或已处理的 Worker 消息 (ID: ${id})`);
                }
            };

            // 设置 Worker 错误处理器 (主线程)
            backupWorker.onerror = function(error) {
                console.error('[聊天自动备份] Web Worker 发生错误:', error);
                 // Reject any pending promises
                 Object.keys(workerPromises).forEach(id => {
                     workerPromises[id].reject(new Error('Worker encountered an unrecoverable error.'));
                     delete workerPromises[id];
                 });
                toastr.error('备份 Worker 发生错误，自动备份可能已停止', '聊天自动备份');
                 // 可以考虑在这里尝试重建 Worker
            };

        } catch (workerError) {
            console.error('[聊天自动备份] 创建 Web Worker 失败:', workerError);
            backupWorker = null; // 确保 worker 实例为空
            toastr.error('无法创建备份 Worker，将回退到主线程备份（性能较低）', '聊天自动备份');
            // 在这种情况下，performDeepCopyInWorker 需要一个回退机制（或插件应禁用/报错）
            // 暂时简化处理：如果Worker创建失败，备份功能将出错
        }

        // 加载插件UI
        const settingsHtml = await renderExtensionTemplateAsync(
            `third-party/${PLUGIN_NAME}`,
            'settings'
        );
        $('#extensions_settings').append(settingsHtml);
        console.log('[聊天自动备份] 已添加设置界面');

        // 设置控制项
        const $settingsBlock = $('<div class="chat_backup_control_item"></div>');
        $settingsBlock.html(`
            <div style="margin-bottom: 8px;">
                <label style="display: inline-block; min-width: 120px;">防抖延迟 (ms):</label>
                <input type="number" id="chat_backup_debounce_delay" value="${settings.backupDebounceDelay}" 
                    min="300" max="10000" step="100" title="编辑或删除消息后，等待多少毫秒再执行备份 (建议 1000-1500)" 
                    style="width: 80px;" />
            </div>
            <div>
                <label style="display: inline-block; min-width: 120px;">系统最大备份数:</label>
                <input type="number" id="chat_backup_max_total" value="${settings.maxTotalBackups}" 
                    min="1" max="10" step="1" title="系统中保留的最大备份数量" 
                    style="width: 80px;" />
            </div>
        `);
        $('.chat_backup_controls').prepend($settingsBlock);
        
        // 添加最大备份数设置监听
        $(document).on('input', '#chat_backup_max_total', function() {
            const total = parseInt($(this).val(), 10);
            if (!isNaN(total) && total >= 1 && total <= 10) {
                settings.maxTotalBackups = total;
                logDebug(`系统最大备份数已更新为: ${total}`);
                saveSettingsDebounced();
            } else {
                logDebug(`无效的系统最大备份数输入: ${$(this).val()}`);
                $(this).val(settings.maxTotalBackups);
            }
        });

        // --- 使用事件委托绑定UI事件 ---
        $(document).on('click', '#chat_backup_manual_backup', performManualBackup);

        // 防抖延迟设置
        $(document).on('input', '#chat_backup_debounce_delay', function() {
            const delay = parseInt($(this).val(), 10);
            if (!isNaN(delay) && delay >= 300 && delay <= 10000) {
                settings.backupDebounceDelay = delay;
                logDebug(`防抖延迟已更新为: ${delay}ms`);
                saveSettingsDebounced();
            } else {
                logDebug(`无效的防抖延迟输入: ${$(this).val()}`);
                $(this).val(settings.backupDebounceDelay);
            }
        });

        // 恢复按钮
        $(document).on('click', '.backup_restore', async function() {
            const button = $(this);
            const timestamp = parseInt(button.data('timestamp'));
            const chatKey = button.data('key');
            logDebug(`点击恢复按钮, timestamp: ${timestamp}, chatKey: ${chatKey}`);

            button.prop('disabled', true).text('恢复中...'); // 禁用按钮并显示状态

            try {
                const db = await getDB();
                const backup = await new Promise((resolve, reject) => {
                    const transaction = db.transaction([STORE_NAME], 'readonly');
                    
                    transaction.onerror = (event) => {
                        reject(event.target.error);
                    };
                    
                    const store = transaction.objectStore(STORE_NAME);
                    const request = store.get([chatKey, timestamp]);
                    
                    request.onsuccess = () => {
                        resolve(request.result);
                    };
                    
                    request.onerror = (event) => {
                        reject(event.target.error);
                    };
                });

                if (backup) {
                    if (confirm(`确定要恢复 " ${backup.entityName} - ${backup.chatName} " 的备份吗？\n\n这将选中对应的角色/群组，并创建一个【新的聊天】来恢复备份内容。\n\n当前聊天内容不会丢失，但请确保已保存。`)) {
                        const success = await restoreBackup(backup);
                        if (success) {
                            toastr.success('聊天记录已成功恢复到新聊天');
                        }
                    }
                } else {
                    console.error('[聊天自动备份] 找不到指定的备份:', { timestamp, chatKey });
                    toastr.error('找不到指定的备份');
                }
            } catch (error) {
                console.error('[聊天自动备份] 恢复过程中出错:', error);
                toastr.error(`恢复过程中出错: ${error.message}`);
            } finally {
                button.prop('disabled', false).text('恢复'); // 恢复按钮状态
            }
        });

        // 删除按钮
        $(document).on('click', '.backup_delete', async function() {
            const button = $(this);
            const timestamp = parseInt(button.data('timestamp'));
            const chatKey = button.data('key');
            logDebug(`点击删除按钮, timestamp: ${timestamp}, chatKey: ${chatKey}`);

            const backupItem = button.closest('.backup_item');
            const entityName = backupItem.find('.backup_entity').text();
            const chatName = backupItem.find('.backup_chat').text();
            const date = backupItem.find('.backup_date').text();

            if (confirm(`确定要永久删除这个备份吗？\n\n实体: ${entityName}\n聊天: ${chatName}\n时间: ${date}\n\n此操作无法撤销！`)) {
                button.prop('disabled', true).text('删除中...');
                try {
                    await deleteBackup(chatKey, timestamp);
                    toastr.success('备份已删除');
                    backupItem.fadeOut(300, function() { $(this).remove(); }); // 平滑移除条目
                    // 可选：如果列表为空，显示提示
                    if ($('#chat_backup_list .backup_item').length <= 1) { // <=1 因为当前这个还在DOM里，将要移除
                        updateBackupsList(); // 重新加载以显示"无备份"提示
                    }
                } catch (error) {
                    console.error('[聊天自动备份] 删除备份失败:', error);
                    toastr.error(`删除备份失败: ${error.message}`);
                    button.prop('disabled', false).text('删除');
                }
            }
        });

        // 预览按钮
        $(document).on('click', '.backup_preview_btn', async function() {
            const button = $(this);
            const timestamp = parseInt(button.data('timestamp'));
            const chatKey = button.data('key');
            logDebug(`点击预览按钮, timestamp: ${timestamp}, chatKey: ${chatKey}`);

            button.prop('disabled', true).text('加载中...'); // 禁用按钮并显示状态

            try {
                const db = await getDB();
                const backup = await new Promise((resolve, reject) => {
                    const transaction = db.transaction([STORE_NAME], 'readonly');
                    
                    transaction.onerror = (event) => {
                        reject(event.target.error);
                    };
                    
                    const store = transaction.objectStore(STORE_NAME);
                    const request = store.get([chatKey, timestamp]);
                    
                    request.onsuccess = () => {
                        resolve(request.result);
                    };
                    
                    request.onerror = (event) => {
                        reject(event.target.error);
                    };
                });

                if (backup && backup.chat && backup.chat.length > 0) {
                    // 获取最后两条消息
                    const chat = backup.chat;
                    const lastMessages = chat.slice(-2);
                    
                    // 过滤标签并处理Markdown
                    const processMessage = (messageText) => {
                        if (!messageText) return '(空消息)';
                        
                        // 过滤<think>和<thinking>标签及其内容
                        let processed = messageText
                            .replace(/<think>[\s\S]*?<\/think>/g, '')
                            .replace(/<thinking>[\s\S]*?<\/thinking>/g, '');
                        
                        // 过滤代码块和白毛控名称
                        processed = processed
                            .replace(/```[\s\S]*?```/g, '')    // 移除代码块
                            .replace(/`[\s\S]*?`/g, '');       // 移除内联代码
                        
                        // 简单的Markdown处理，保留部分格式
                        processed = processed
                            .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')  // 粗体
                            .replace(/\*(.*?)\*/g, '<em>$1</em>')              // 斜体
                            .replace(/\n\n+/g, '\n')                         // 多个连续换行替换为两个
                            .replace(/\n/g, '<br>');                           // 换行
                        
                        return processed;
                    };
                    
                    // 创建样式
                    const style = document.createElement('style');
                    style.textContent = `
                        .message_box {
                            padding: 10px;
                            margin-bottom: 10px;
                            border-radius: 8px;
                            background: rgba(0, 0, 0, 0.15);
                        }
                        .message_sender {
                            font-weight: bold;
                            margin-bottom: 5px;
                            color: var(--SmColor);
                        }
                        .message_content {
                            white-space: pre-wrap;
                            line-height: 1.4;
                        }
                        .message_content br + br {
                            margin-top: 0.5em;
                        }
                    `;
                    
                    // 创建预览内容
                    const previewContent = document.createElement('div');
                    previewContent.appendChild(style);
                    
                    const headerDiv = document.createElement('h3');
                    headerDiv.textContent = `${backup.entityName} - ${backup.chatName} 预览`;
                    previewContent.appendChild(headerDiv);
                    
                    const contentDiv = document.createElement('div');
                    
                    // 为每条消息创建单独的盒子
                    lastMessages.forEach(msg => {
                        const messageBox = document.createElement('div');
                        messageBox.className = 'message_box';
                        
                        const senderDiv = document.createElement('div');
                        senderDiv.className = 'message_sender';
                        senderDiv.textContent = msg.name || '未知';
                        
                        const contentDiv = document.createElement('div');
                        contentDiv.className = 'message_content';
                        contentDiv.innerHTML = processMessage(msg.mes);
                        
                        messageBox.appendChild(senderDiv);
                        messageBox.appendChild(contentDiv);
                        
                        previewContent.appendChild(messageBox);
                    });
                    
                    const footerDiv = document.createElement('div');
                    footerDiv.style.marginTop = '10px';
                    footerDiv.style.opacity = '0.7';
                    footerDiv.style.fontSize = '0.9em';
                    footerDiv.textContent = `显示最后 ${lastMessages.length} 条消息，共 ${chat.length} 条`;
                    previewContent.appendChild(footerDiv);
                    
                    // 导入对话框系统
                    const { callGenericPopup, POPUP_TYPE } = await import('../../../popup.js');
                    
                    // 使用系统弹窗显示预览内容
                    await callGenericPopup(previewContent, POPUP_TYPE.DISPLAY, '', {
                        wide: true,
                        allowVerticalScrolling: true,
                        leftAlign: true,
                        okButton: '关闭'
                    });
                    
                } else {
                    console.error('[聊天自动备份] 找不到指定的备份或备份为空:', { timestamp, chatKey });
                    toastr.error('找不到指定的备份或备份为空');
                }
            } catch (error) {
                console.error('[聊天自动备份] 预览过程中出错:', error);
                toastr.error(`预览过程中出错: ${error.message}`);
            } finally {
                button.prop('disabled', false).text('预览'); // 恢复按钮状态
            }
        });

        // 调试开关
        $(document).on('change', '#chat_backup_debug_toggle', function() {
            settings.debug = $(this).prop('checked');
            console.log('[聊天自动备份] 调试模式已' + (settings.debug ? '启用' : '禁用'));
            saveSettingsDebounced();
        });

        // 初始化UI状态 (延迟确保DOM渲染完毕)
        setTimeout(async () => {
            $('#chat_backup_debug_toggle').prop('checked', settings.debug);
            $('#chat_backup_debounce_delay').val(settings.backupDebounceDelay);
            $('#chat_backup_max_total').val(settings.maxTotalBackups);
            await updateBackupsList();
        }, 300);

        // --- 设置优化后的事件监听 ---
        function setupBackupEvents() {
            // 立即触发备份的事件 (状态明确结束)
            const immediateBackupEvents = [
                event_types.MESSAGE_SENT,           // 用户发送消息后
                event_types.GENERATION_ENDED,       // AI生成完成并添加消息后
                event_types.CHARACTER_FIRST_MESSAGE_SELECTED, // 选择角色第一条消息时                
            ].filter(Boolean); // 过滤掉可能不存在的事件类型

            // 触发防抖备份的事件 (编辑性操作)
            const debouncedBackupEvents = [
                event_types.MESSAGE_EDITED,        // 编辑消息后 (防抖)
                event_types.MESSAGE_DELETED,       // 删除消息后 (防抖)
                event_types.MESSAGE_SWIPED,         // 用户切换AI回复后 (防抖)
                event_types.IMAGE_SWIPED,           // 图片切换 (防抖)
                event_types.MESSAGE_FILE_EMBEDDED, // 文件嵌入 (防抖)
                event_types.MESSAGE_REASONING_EDITED, // 编辑推理 (防抖)
                event_types.MESSAGE_REASONING_DELETED, // 删除推理 (防抖)
                event_types.FILE_ATTACHMENT_DELETED, // 附件删除 (防抖)
                event_types.GROUP_UPDATED, //群组元数据更新 (防抖)
            ].filter(Boolean);

            console.log('[聊天自动备份] 设置立即备份事件监听:', immediateBackupEvents);
            immediateBackupEvents.forEach(eventType => {
                if (!eventType) {
                    console.warn('[聊天自动备份] 检测到未定义的立即备份事件类型');
                    return;
                }
                eventSource.on(eventType, () => {
                    logDebug(`事件触发 (立即备份): ${eventType}`);
                    // 使用新的条件备份函数
                    performBackupConditional().catch(error => {
                        console.error(`[聊天自动备份] 立即备份事件 ${eventType} 处理失败:`, error);
                    });
                });
            });

            console.log('[聊天自动备份] 设置防抖备份事件监听:', debouncedBackupEvents);
            debouncedBackupEvents.forEach(eventType => {
                if (!eventType) {
                    console.warn('[聊天自动备份] 检测到未定义的防抖备份事件类型');
                    return;
                }
                eventSource.on(eventType, () => {
                    logDebug(`事件触发 (防抖备份): ${eventType}`);
                    // 使用新的防抖备份函数
                    performBackupDebounced();
                });
            });

            console.log('[聊天自动备份] 事件监听器设置完成');
        }

        setupBackupEvents(); // 应用新的事件绑定逻辑

        // 监听扩展页面打开事件，刷新列表
        $(document).on('click', '#extensionsMenuButton', () => {
            if ($('#chat_auto_backup_settings').is(':visible')) {
                console.log('[聊天自动备份] 扩展菜单按钮点击，且本插件设置可见，刷新备份列表');
                setTimeout(updateBackupsList, 200); // 稍作延迟确保面板内容已加载
            }
        });

        // 抽屉打开时也刷新
        $(document).on('click', '#chat_auto_backup_settings .inline-drawer-toggle', function() {
            const drawer = $(this).closest('.inline-drawer');
            // 检查抽屉是否即将打开 (基于当前是否有 open class)
            if (!drawer.hasClass('open')) {
                console.log('[聊天自动备份] 插件设置抽屉打开，刷新备份列表');
                setTimeout(updateBackupsList, 50); // 几乎立即刷新
            }
        });

        // 初始备份检查 (延迟执行，确保聊天已加载)
        setTimeout(async () => {
            logDebug('[聊天自动备份] 执行初始备份检查');
            const context = getContext();
            if (context.chat && context.chat.length > 0 && !isBackupInProgress) {
                logDebug('[聊天自动备份] 发现现有聊天记录，执行初始备份');
                try {
                    await performBackupConditional(); // 使用条件函数
                } catch (error) {
                    console.error('[聊天自动备份] 初始备份执行失败:', error);
                }
            } else {
                logDebug('[聊天自动备份] 当前没有聊天记录或备份进行中，跳过初始备份');
            }
        }, 4000); // 稍长延迟，等待应用完全初始化

        console.log('[聊天自动备份] 插件加载完成');

    } catch (error) {
        console.error('[聊天自动备份] 插件加载过程中发生严重错误:', error);
        // 可以在UI上显示错误信息
        $('#extensions_settings').append(
            '<div class="error">聊天自动备份插件加载失败，请检查控制台。</div>'
        );
    }
});
