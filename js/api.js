class API {
    constructor() {
        this.accessToken = localStorage.getItem('access_token');
        this.tokenExpireTime = localStorage.getItem('token_expire_time');
    }

    // 获取访问令牌
    async getAccessToken() {
        if (this.accessToken && this.tokenExpireTime && new Date().getTime() < this.tokenExpireTime) {
            return this.accessToken;
        }

        const response = await fetch(`${CONFIG.API_BASE_URL}/api/v1/access_token`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Platform': 'open_platform'
            },
            body: JSON.stringify({
                clientID: CONFIG.CLIENT_ID,
                clientSecret: CONFIG.CLIENT_SECRET
            })
        });

        const data = await response.json();
        if (data.code === 0) {
            this.accessToken = data.data.accessToken;
            this.tokenExpireTime = new Date(data.data.expiredAt).getTime();
            localStorage.setItem('access_token', this.accessToken);
            localStorage.setItem('token_expire_time', this.tokenExpireTime);
            return this.accessToken;
        } else {
            throw new Error(data.message);
        }
    }

    // API请求封装
    async request(url, options = {}) {
        const token = await this.getAccessToken();
        const defaultOptions = {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Platform': 'open_platform',
                'Content-Type': 'application/json'
            }
        };

        const response = await fetch(url, { ...defaultOptions, ...options });
        const data = await response.json();
        
        if (data.code === 0) {
            return data.data;
        } else {
            throw new Error(data.message);
        }
    }

    // 创建文件夹
    async createFolder(name, parentID = 0) {
        return await this.request(`${CONFIG.API_BASE_URL}/upload/v1/file/mkdir`, {
            method: 'POST',
            body: JSON.stringify({ 
                name, 
                parentID
            })
        });
    }

    // 获取文件列表
    async getFileList(parentFileId = 0, limit = 100) {
        const result = await this.request(
            `${CONFIG.API_BASE_URL}/api/v2/file/list?parentFileId=${parentFileId}&limit=${limit}`
        );
        // 过滤掉.config文件
        if (result.fileList) {
            result.fileList = result.fileList.filter(file => file.filename !== '.config');
        }
        return result;
    }

    // 获取上传地址
    async getUploadUrl(preuploadID, sliceNo) {
        return await this.request(`${CONFIG.API_BASE_URL}/upload/v1/file/get_upload_url`, {
            method: 'POST',
            body: JSON.stringify({ preuploadID, sliceNo })
        });
    }

    // 创建文件（预上传）
    async createFile(filename, parentFileID, etag, size) {
        return await this.request(`${CONFIG.API_BASE_URL}/upload/v1/file/create`, {
            method: 'POST',
            body: JSON.stringify({ filename, parentFileID, etag, size })
        });
    }

    // 完成上传
    async completeUpload(preuploadID) {
        return await this.request(`${CONFIG.API_BASE_URL}/upload/v1/file/upload_complete`, {
            method: 'POST',
            body: JSON.stringify({ preuploadID })
        });
    }

    // 获取直链
    async getDirectLink(fileID) {
        // 先启用直链空间
        try {
            await this.request(`${CONFIG.API_BASE_URL}/api/v1/direct-link/enable`, {
                method: 'POST',
                body: JSON.stringify({ fileID: parseInt(fileID) })
            });
        } catch (error) {
            // 如果已经启用，忽略错误
            console.log('直链空间已启用或启用失败:', error);
        }

        // 获取直链
        const result = await this.request(`${CONFIG.API_BASE_URL}/api/v1/direct-link/url`, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${await this.getAccessToken()}`,
                'Platform': 'open_platform'
            }
        });

        if (!result || !result.url) {
            throw new Error('获取下载链接失败');
        }

        return result;
    }

    // 获取或创建配置文件夹
    async getConfigFolder() {
        try {
            // 直接获取根目录下的所有文件夹
            const response = await fetch(`${CONFIG.API_BASE_URL}/api/v2/file/list?parentFileId=0&limit=100`, {
                headers: {
                    'Authorization': `Bearer ${await this.getAccessToken()}`,
                    'Platform': 'open_platform'
                }
            });
            const data = await response.json();
            
            if (data.code !== 0) {
                throw new Error(data.message);
            }

            let configFolder = data.data.fileList.find(f => f.filename === '.config' && f.type === 1);
            
            if (!configFolder) {
                // 创建配置文件夹
                const createResponse = await fetch(`${CONFIG.API_BASE_URL}/upload/v1/file/mkdir`, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${await this.getAccessToken()}`,
                        'Platform': 'open_platform',
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        name: '.config',
                        parentID: 0
                    })
                });
                
                const createData = await createResponse.json();
                if (createData.code !== 0) {
                    throw new Error(createData.message);
                }
                
                configFolder = { fileId: createData.data.dirID };
            }
            
            return configFolder;
        } catch (error) {
            console.error('获取配置文件夹失败:', error);
            throw error;
        }
    }

    // 读取配置信息
    async readConfig(configName) {
        try {
            const configFolder = await this.getConfigFolder();
            
            // 获取配置文件夹下的文件
            const response = await fetch(`${CONFIG.API_BASE_URL}/api/v2/file/list?parentFileId=${configFolder.fileId}&limit=100`, {
                headers: {
                    'Authorization': `Bearer ${await this.getAccessToken()}`,
                    'Platform': 'open_platform'
                }
            });
            
            const data = await response.json();
            if (data.code !== 0) {
                throw new Error(data.message);
            }

            // 查找所有以指定配置名开头的文件
            const configFiles = data.data.fileList.filter(f => 
                f.filename.startsWith(configName) && f.type === 0
            );

            // 将文件名转换为配置对象
            const config = {};
            configFiles.forEach(file => {
                try {
                    const parts = file.filename.split('-');
                    if (parts.length === 3) {
                        const key = atob(parts[1].replace(/_/g, '='));
                        const value = atob(parts[2].replace(/_/g, '=').replace('.cfg', ''));
                        config[key] = value;
                    }
                } catch (e) {
                    console.error('解析配置文件名失败:', e);
                }
            });

            return config;
        } catch (error) {
            console.error('读取配置文件失败:', error);
            return null;
        }
    }

    // 保存配置信息
    async saveConfig(configName, data) {
        try {
            const configFolder = await this.getConfigFolder();
            
            // 获取当前配置文件
            const response = await fetch(`${CONFIG.API_BASE_URL}/api/v2/file/list?parentFileId=${configFolder.fileId}&limit=100`, {
                headers: {
                    'Authorization': `Bearer ${await this.getAccessToken()}`,
                    'Platform': 'open_platform'
                }
            });
            
            const listData = await response.json();
            if (listData.code !== 0) {
                throw new Error(listData.message);
            }

            // 删除旧的配置文件
            const oldConfigFiles = listData.data.fileList.filter(f => 
                f.filename.startsWith(configName) && f.type === 0
            );
            
            if (oldConfigFiles.length > 0) {
                await fetch(`${CONFIG.API_BASE_URL}/api/v1/file/trash`, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${await this.getAccessToken()}`,
                        'Platform': 'open_platform',
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        fileIDs: oldConfigFiles.map(f => f.fileId)
                    })
                });
            }

            // 创建新的配置文件
            for (const [key, value] of Object.entries(data)) {
                if (value) {  // 只保存非空值
                    // 使用Base64编码避免特殊字符
                    const encodedKey = btoa(key).replace(/=/g, '_');
                    const encodedValue = btoa(value).replace(/=/g, '_');
                    const filename = `${configName}-${encodedKey}-${encodedValue}.cfg`;
                    const content = '';  // 空文件内容
                    const blob = new Blob([content], { type: 'text/plain' });
                    const file = new File([blob], filename, { type: 'text/plain' });
                    
                    // 创建文件
                    const etag = CryptoJS.MD5(content).toString();
                    const createResponse = await fetch(`${CONFIG.API_BASE_URL}/upload/v1/file/create`, {
                        method: 'POST',
                        headers: {
                            'Authorization': `Bearer ${await this.getAccessToken()}`,
                            'Platform': 'open_platform',
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify({
                            filename: filename,
                            parentFileID: configFolder.fileId,
                            etag: etag,
                            size: file.size
                        })
                    });

                    const createData = await createResponse.json();
                    if (createData.code !== 0) {
                        throw new Error(createData.message);
                    }

                    // 如果不是秒传，则需要上传
                    if (!createData.data.reuse) {
                        const uploadUrlResponse = await fetch(`${CONFIG.API_BASE_URL}/upload/v1/file/get_upload_url`, {
                            method: 'POST',
                            headers: {
                                'Authorization': `Bearer ${await this.getAccessToken()}`,
                                'Platform': 'open_platform',
                                'Content-Type': 'application/json'
                            },
                            body: JSON.stringify({
                                preuploadID: createData.data.preuploadID,
                                sliceNo: 1
                            })
                        });

                        const uploadUrlData = await uploadUrlResponse.json();
                        if (uploadUrlData.code !== 0) {
                            throw new Error(uploadUrlData.message);
                        }

                        // 上传文件
                        const uploadResponse = await fetch(uploadUrlData.data.presignedURL, {
                            method: 'PUT',
                            body: file
                        });

                        if (!uploadResponse.ok) {
                            throw new Error('上传配置文件失败');
                        }

                        // 完成上传
                        const completeResponse = await fetch(`${CONFIG.API_BASE_URL}/upload/v1/file/upload_complete`, {
                            method: 'POST',
                            headers: {
                                'Authorization': `Bearer ${await this.getAccessToken()}`,
                                'Platform': 'open_platform',
                                'Content-Type': 'application/json'
                            },
                            body: JSON.stringify({
                                preuploadID: createData.data.preuploadID
                            })
                        });

                        const completeData = await completeResponse.json();
                        if (completeData.code !== 0) {
                            throw new Error(completeData.message);
                        }
                    }
                }
            }
            
            return true;
        } catch (error) {
            console.error('保存配置文件失败:', error);
            throw error;
        }
    }

    // 获取文件夹密码
    async getFolderPassword(folderID) {
        try {
            const config = await this.readConfig('folder_passwords');
            return config ? config[folderID] : null;
        } catch (error) {
            console.error('获取文件夹密码失败:', error);
            return null;
        }
    }

    // 设置文件夹密码
    async setFolderPassword(folderID, password) {
        try {
            let config = await this.readConfig('folder_passwords') || {};
            if (password) {
                config[folderID] = password;
            } else {
                delete config[folderID];
            }
            await this.saveConfig('folder_passwords', config);
            console.log('密码设置成功:', folderID, password ? '已设置密码' : '已移除密码');
        } catch (error) {
            console.error('设置文件夹密码失败:', error);
            throw error;
        }
    }
}

// 创建全局API实例
const api = new API(); 