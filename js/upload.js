class FileUploader {
    constructor(file, parentFileID = 0) {
        this.file = file;
        this.parentFileID = parentFileID;
        this.aborted = false;
        this.uploadedSize = 0;
        this.uploadStartTime = 0;
    }

    // 分片计算MD5
    async calculateMD5() {
        const chunkSize = 10 * 1024 * 1024; // 增加到10MB chunks
        const chunks = Math.ceil(this.file.size / chunkSize);
        let md5Hash = CryptoJS.algo.MD5.create();
        let processedSize = 0;
        
        // 创建Web Worker
        const worker = new Worker('js/md5worker.js');
        
        for (let i = 0; i < chunks && !this.aborted; i++) {
            const start = i * chunkSize;
            const end = Math.min(start + chunkSize, this.file.size);
            const chunk = await this.readChunk(start, end);
            
            if (!chunk) {
                throw new Error('读取文件失败');
            }

            // 使用Promise包装Worker的消息处理
            const result = await new Promise((resolve, reject) => {
                worker.onmessage = (e) => {
                    if (e.data.success) {
                        resolve(e.data);
                    } else {
                        reject(new Error(e.data.error));
                    }
                };
                
                worker.onerror = (e) => {
                    reject(new Error('Worker error: ' + e.message));
                };

                // 发送数据到Worker
                worker.postMessage({
                    chunk,
                    totalSize: this.file.size,
                    processedSize
                });
            });

            // 更新进度
            processedSize = result.processedSize;
            const progress = result.progress;
            
            // 更新MD5
            const wordArray = CryptoJS.enc.Hex.parse(result.md5);
            md5Hash.update(wordArray);

            // 更新进度显示
            this.onProgress && this.onProgress(0, `正在计算MD5: ${progress}%`, {
                uploadedSize: processedSize,
                totalSize: this.file.size,
                speed: 0
            });
        }
        
        // 终止Worker
        worker.terminate();
        
        return md5Hash.finalize().toString();
    }

    // 读取文件分片
    readChunk(start, end) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = e => resolve(e.target.result);
            reader.onerror = e => {
                console.error('读取文件分片失败:', e);
                reject(e);
            };
            reader.readAsArrayBuffer(this.file.slice(start, end));
        });
    }

    // 分片上传
    async uploadChunk(chunk, url) {
        try {
            const response = await fetch(url, {
                method: 'PUT',
                body: chunk
            });
            return response.ok;
        } catch (error) {
            console.error('分片上传失败:', error);
            return false;
        }
    }

    // 开始上传
    async start(onProgress) {
        this.onProgress = onProgress;
        this.uploadedSize = 0;
        try {
            // 1. 计算文件MD5
            onProgress && onProgress(0, '正在计算MD5: 0.00%', { uploadedSize: 0, totalSize: this.file.size });
            const etag = await this.calculateMD5();
            if (this.aborted) {
                throw new Error('上传已取消');
            }
            
            // 2. 创建文件
            onProgress && onProgress(0, '准备上传...', { uploadedSize: 0, totalSize: this.file.size });
            const createResult = await api.createFile(
                this.file.name,
                this.parentFileID,
                etag,
                this.file.size
            );

            // 检查是否秒传成功
            if (createResult.reuse) {
                onProgress && onProgress(100, '上传完成（秒传）', { 
                    uploadedSize: this.file.size, 
                    totalSize: this.file.size,
                    speed: 0
                });
                return createResult.fileID;
            }

            // 3. 分片上传
            const preuploadID = createResult.preuploadID;
            const sliceSize = createResult.sliceSize || CONFIG.SLICE_SIZE;
            const chunks = Math.ceil(this.file.size / sliceSize);
            this.uploadStartTime = Date.now();

            for (let i = 0; i < chunks && !this.aborted; i++) {
                // 获取分片上传地址
                const urlResult = await api.getUploadUrl(preuploadID, i + 1);
                
                // 切分文件
                const start = i * sliceSize;
                const end = Math.min(start + sliceSize, this.file.size);
                const chunk = this.file.slice(start, end);

                // 上传分片
                const success = await this.uploadChunk(chunk, urlResult.presignedURL);
                if (!success) {
                    throw new Error('分片上传失败');
                }
                
                // 更新已上传大小
                this.uploadedSize += chunk.size;
                
                // 计算上传速度（字节/秒）
                const elapsedTime = (Date.now() - this.uploadStartTime) / 1000; // 转换为秒
                const speed = this.uploadedSize / elapsedTime;
                
                // 计算进度
                const progress = (this.uploadedSize * 100 / this.file.size).toFixed(2);
                
                onProgress && onProgress(Number(progress), `正在上传: ${progress}%`, {
                    uploadedSize: this.uploadedSize,
                    totalSize: this.file.size,
                    speed: speed
                });
            }

            if (this.aborted) {
                throw new Error('上传已取消');
            }

            // 4. 完成上传
            onProgress && onProgress(99.99, '正在完成上传...', {
                uploadedSize: this.uploadedSize,
                totalSize: this.file.size,
                speed: 0
            });
            const completeResult = await api.completeUpload(preuploadID);
            onProgress && onProgress(100, '上传完成', {
                uploadedSize: this.file.size,
                totalSize: this.file.size,
                speed: 0
            });
            return completeResult.fileID;
        } catch (error) {
            if (!this.aborted) {
                console.error('上传失败:', error);
                throw error;
            }
            throw new Error('上传已取消');
        }
    }

    // 取消上传
    abort() {
        this.aborted = true;
    }
}

// 上传管理器
class UploadManager {
    constructor() {
        this.uploads = new Map();
    }

    // 添加上传任务
    async addUpload(file, parentFileID = 0) {
        const uploader = new FileUploader(file, parentFileID);
        this.uploads.set(file.name, uploader);

        try {
            const fileID = await uploader.start((progress, status, uploadInfo) => {
                // 触发进度更新事件
                const event = new CustomEvent('uploadProgress', {
                    detail: { 
                        filename: file.name, 
                        progress, 
                        status,
                        uploadedSize: uploadInfo.uploadedSize,
                        totalSize: uploadInfo.totalSize,
                        speed: uploadInfo.speed
                    }
                });
                window.dispatchEvent(event);
            });

            // 触发上传完成事件
            const event = new CustomEvent('uploadComplete', {
                detail: { filename: file.name, fileID }
            });
            window.dispatchEvent(event);

            this.uploads.delete(file.name);
            return fileID;
        } catch (error) {
            // 如果不是主动取消，触发错误事件
            if (!uploader.aborted) {
                const event = new CustomEvent('uploadError', {
                    detail: { filename: file.name, error: error.message }
                });
                window.dispatchEvent(event);
            }

            this.uploads.delete(file.name);
            throw error;
        }
    }

    // 取消上传
    cancelUpload(filename) {
        const uploader = this.uploads.get(filename);
        if (uploader) {
            uploader.abort();
            this.uploads.delete(filename);
            // 触发取消事件
            const event = new CustomEvent('uploadCancelled', {
                detail: { filename }
            });
            window.dispatchEvent(event);
        }
    }
}

// 创建全局上传管理器实例
const uploadManager = new UploadManager(); 