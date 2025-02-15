importScripts('https://cdnjs.cloudflare.com/ajax/libs/crypto-js/4.1.1/crypto-js.min.js');

self.onmessage = async function(e) {
    const { chunk, totalSize, processedSize } = e.data;
    
    try {
        // 计算当前分片的MD5
        const wordArray = CryptoJS.lib.WordArray.create(chunk);
        const md5 = CryptoJS.MD5(wordArray).toString();
        
        // 计算进度
        const newProcessedSize = processedSize + chunk.byteLength;
        const progress = (newProcessedSize * 100 / totalSize).toFixed(2);
        
        // 发送结果回主线程
        self.postMessage({
            success: true,
            md5,
            processedSize: newProcessedSize,
            progress
        });
    } catch (error) {
        self.postMessage({
            success: false,
            error: error.message
        });
    }
}; 