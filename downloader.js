self.importScripts("common.js");

function Downloader() {
    this.logger = new Logger("Downloader");
}

Downloader.prototype.getFileInfo = function (url) {
    this.logger.logInfo("Getting file size " + url + ".");
    var size = 0;
    var status = 0;
    var reported = false;

    var xhr = new XMLHttpRequest();
    xhr.open('get', url, true);
    xhr.onreadystatechange = () => {
        var len = xhr.getResponseHeader("Content-Length");
        if (len) {
            size = len;
        }

        if (xhr.status) {
            status = xhr.status;
        }

        //Completed.
        if (!reported && ((size > 0 && status > 0) || xhr.readyState == 4)) {
            var objData = {
                t: kGetFileInfoRsp,
                i: {
                    sz: size,
                    st: status
                }
            };

            //this.logger.logInfo("File size " + size + " bytes, status " + status + ".");
            self.postMessage(objData);
            reported = true;
            xhr.abort();
        }
    };
    xhr.send();
};

Downloader.prototype.downloadFile = function (url, start, end, seq) {
    //this.logger.logInfo("Downloading file " + url + ", bytes=" + start + "-" + end + ".");
    var xhr = new XMLHttpRequest;
    xhr.open('get', url, true);
    xhr.responseType = 'arraybuffer';
    xhr.setRequestHeader("Range", "bytes=" + start + "-" + end);
    xhr.onload = function () {
        var objData = {
            t: kFileData,
            s: start,
            e: end,
            d: xhr.response,
            q: seq
        };
        self.postMessage(objData, [objData.d]);
    };
    xhr.send();
};

self.downloader = new Downloader();

self.onmessage = function (evt) {
    if (!self.downloader) {
        console.log("[ER] Downloader not initialized!");
        return;
    }

    var objData = evt.data;
    switch (objData.t) {
        case kGetFileInfoReq:
            self.downloader.getFileInfo(objData.u);
            break;
        case kDownloadFileReq:
            self.downloader.downloadFile(objData.u, objData.s, objData.e, objData.q);
            break;
        case kCloseDownloaderReq:
            //Nothing to do.
            break;
        default:
            self.downloader.logger.logError("Unsupport messsage " + objData.t);
    }
};
