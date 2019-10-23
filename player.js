//Decoder states.
const decoderStateIdle          = 0;
const decoderStateInitializing  = 1;
const decoderStateReady         = 2;
const decoderStateFinished      = 3;

//Player states.
const playerStateIdle           = 0;
const playerStatePlaying        = 1;
const playerStatePausing        = 2;

//Constant.
const maxVideoFrameQueueSize    = 16;
const downloadSpeedByteRateCoef = 1.5;

function FileInfo(url) {
    this.url = url;
    this.size = 0;
    this.offset = 0;
    this.chunkSize = 65536;
}

function Player() {
    this.fileInfo           = null;
    this.pcmPlayer          = null;
    this.canvas             = null;
    this.webglPlayer        = null;
    this.callback           = null;
    this.waitHeaderLength   = 524288;
    this.duration           = 0;
    this.pixFmt             = 0;
    this.videoWidth         = 0;
    this.videoHeight        = 0;
    this.yLength            = 0;
    this.uvLength           = 0;
    this.beginTimeOffset    = 0;
    this.decoderState       = decoderStateIdle;
    this.playerState        = playerStateIdle;
    this.decoding           = false;
    this.decodeInterval     = 5;
    this.audioQueue         = [];
    this.videoQueue         = [];
    this.videoRendererTimer = null;
    this.downloadTimer      = null;
    this.chunkInterval      = 200;
    this.downloadSeqNo      = 0;
    this.downloading        = false;
    this.timeLabel          = null;
    this.timeTrack          = null;
    this.trackTimer         = null;
    this.trackTimerInterval = 500;
    this.displayDuration    = "00:00:00";
    this.audioEncoding      = "";
    this.audioChannels      = 0;
    this.audioSampleRate    = 0;
    this.seeking            = false;  // Flag to preventing multi seek from track.
    this.justSeeked         = false;  // Flag to preventing multi seek from ffmpeg.
    this.urgent             = false;
    this.loadingDiv         = null;
    this.logger             = new Logger("Player");
    this.initDownloadWorker();
    this.initDecodeWorker();
}

Player.prototype.initDownloadWorker = function () {
    var self = this;
    this.downloadWorker = new Worker("downloader.js");
    this.downloadWorker.onmessage = function (evt) {
        var objData = evt.data;
        switch (objData.t) {
            case kGetFileInfoRsp:
                self.onGetFileInfo(objData.i);
                break;
            case kFileData:
                self.onFileData(objData.d, objData.s, objData.e, objData.q);
                break;
        }
    }
};

Player.prototype.initDecodeWorker = function () {
    var self = this;
    this.decodeWorker = new Worker("decoder.js");
    this.decodeWorker.onmessage = function (evt) {
        var objData = evt.data;
        switch (objData.t) {
            case kInitDecoderRsp:
                self.onInitDecoder(objData);
                break;
            case kOpenDecoderRsp:
                self.onOpenDecoder(objData);
                break;
            case kVideoFrame:
                self.onVideoFrame(objData);
                break;
            case kAudioFrame:
                self.onAudioFrame(objData);
                break;
            case kDecodeFinishedEvt:
                self.onDecodeFinished(objData);
                break;
            case kRequestDataEvt:
                self.onRequestData(objData.o);
                break;
            case kSeekToRsp:
                self.onSeekToRsp(objData.r);
                break;
        }
    }
};

Player.prototype.play = function (url, canvas, callback, waitHeaderLength) {
    this.logger.logInfo("Play " + url + ".");

    var ret = {
        e: 0,
        m: "Success"
    };

    var success = true;
    do {
        if (this.playerState == playerStatePausing) {
            ret = this.resume();
            break;
        }

        if (this.playerState == playerStatePlaying) {
            break;
        }

        if (!url) {
            ret = {
                e: -1,
                m: "Invalid url"
            };
            success = false;
            this.logger.logError("[ER] playVideo error, url empty.");
            break;
        }

        if (!canvas) {
            ret = {
                e: -2,
                m: "Canvas not set"
            };
            success = false;
            this.logger.logError("[ER] playVideo error, canvas empty.");
            break;
        }

        if (!this.downloadWorker) {
            ret = {
                e: -3,
                m: "Downloader not initialized"
            };
            success = false;
            this.logger.logError("[ER] Downloader not initialized.");
            break
        }

        if (!this.decodeWorker) {
            ret = {
                e: -4,
                m: "Decoder not initialized"
            };
            success = false;
            this.logger.logError("[ER] Decoder not initialized.");
            break
        }

        this.fileInfo = new FileInfo(url);
        this.canvas = canvas;
        this.callback = callback;
        this.waitHeaderLength = waitHeaderLength || this.waitHeaderLength;
        this.playerState = playerStatePlaying;
        this.startTrackTimer();
        this.displayLoop();

        //var playCanvasContext = playCanvas.getContext("2d"); //If get 2d, webgl will be disabled.
        this.webglPlayer = new WebGLPlayer(this.canvas, {
            preserveDrawingBuffer: false
        });

        var req = {
            t: kGetFileInfoReq,
            u: url
        };
        this.downloadWorker.postMessage(req);
    } while (false);

    return ret;
};

Player.prototype.pause = function () {
    this.logger.logInfo("Pause.");

    if (this.playerState != playerStatePlaying) {
        var ret = {
            e: -1,
            m: "Not playing"
        };
        return ret;
    }

    //Pause video rendering and audio flushing.
    this.playerState = playerStatePausing;

    //Pause audio context.
    this.pcmPlayer.pause();

    //Pause decoding.
    this.pauseDecoding();

    //Stop track timer.
    this.stopTrackTimer();

    //Do not stop downloader for background buffering.
    var ret = {
        e: 0,
        m: "Success"
    };

    return ret;
};

Player.prototype.resume = function () {
    this.logger.logInfo("Resume.");

    if (this.playerState != playerStatePausing) {
        var ret = {
            e: -1,
            m: "Not pausing"
        };
        return ret;
    }

    //Resume audio context.
    this.pcmPlayer.resume();

    //Flush cached flying audio data under pausing state.
    while (this.audioQueue.length > 0) {
        //this.logger.logDebug("Flush one cache audio.");
        var data = this.audioQueue.shift();
        this.pcmPlayer.play(data);
    }

    //If there's a flying video renderer op, interrupt it.
    if (this.videoRendererTimer != null) {
        clearTimeout(this.videoRendererTimer);
        this.videoRendererTimer = null;
    }

    //Restart video rendering and audio flushing.
    this.playerState = playerStatePlaying;

    //Restart decoding.
    this.startDecoding();

    //Restart track timer.
    if (!this.seeking) {
        this.startTrackTimer();
    }

    var ret = {
        e: 0,
        m: "Success"
    };
    return ret;
};

Player.prototype.stop = function () {
    this.logger.logInfo("Stop.");
    if (this.playerState == playerStateIdle) {
        var ret = {
            e: -1,
            m: "Not playing"
        };
        return ret;
    }

    if (this.videoRendererTimer != null) {
        clearTimeout(this.videoRendererTimer);
        this.videoRendererTimer = null;
        this.logger.logInfo("Video renderer timer stopped.");
    }

    this.stopDownloadTimer();
    this.stopTrackTimer();

    this.fileInfo           = null;
    this.canvas             = null;
    this.webglPlayer        = null;
    this.callback           = null;
    this.duration           = 0;
    this.pixFmt             = 0;
    this.videoWidth         = 0;
    this.videoHeight        = 0;
    this.yLength            = 0;
    this.uvLength           = 0;
    this.decoderState       = decoderStateIdle;
    this.playerState        = playerStateIdle;
    this.decoding           = false;
    this.audioQueue         = [];
    this.videoQueue         = [];

    if (this.pcmPlayer) {
        this.pcmPlayer.destroy();
        this.pcmPlayer = null;
        this.logger.logInfo("Pcm player released.");
    }

    this.logger.logInfo("Closing decoder.");
    this.decodeWorker.postMessage({
        t: kCloseDecoderReq
    });


    this.logger.logInfo("Uniniting decoder.");
    this.decodeWorker.postMessage({
        t: kUninitDecoderReq
    });

    return ret;
};

Player.prototype.seekTo = function(ms) {
    // Pause playing.
    this.pause();

    // Stop download.
    this.stopDownloadTimer();

    // Clear video queue.
    this.videoQueue.length = 0;

    // Clear audio queue.
    this.audioQueue.length = 0;

    // Request decoder to seek.
    this.decodeWorker.postMessage({
        t: kSeekToReq,
        ms: ms
    });

    // Reset begin time offset.
    //this.logger.logInfo("this.beginTimeOffset = -1");
    this.beginTimeOffset = ms / 1000;

    this.seeking = true;
    this.justSeeked = true;
    this.showLoading();
};

Player.prototype.fullscreen = function () {
    if (this.webglPlayer) {
        this.webglPlayer.fullscreen();
    }
};

Player.prototype.getState = function () {
    return this.playerState;
};

Player.prototype.setTrack = function (timeTrack, timeLabel) {
    this.timeTrack = timeTrack;
    this.timeLabel = timeLabel;

    if (this.timeTrack) {
        var self = this;
        this.timeTrack.oninput = function () {
            if (!self.seeking) {
                self.seekTo(self.timeTrack.value);
            }
        }
        this.timeTrack.onchange = function () {
            if (!self.seeking) {
                self.seekTo(self.timeTrack.value);
            }
        }
    }
};

Player.prototype.onGetFileInfo = function (info) {
    if (this.playerState == playerStateIdle) {
        return;
    }

    this.logger.logInfo("Got file size rsp:" + info.st + " size:" + info.sz + " byte.");
    if (info.st == 200) {
        this.fileInfo.size = info.sz;
        this.logger.logInfo("Initializing decoder.");
        var req = {
            t: kInitDecoderReq,
            s: this.fileInfo.size,
            c: this.fileInfo.chunkSize
        };
        this.decodeWorker.postMessage(req);
    } else {
        this.reportPlayError(-1, info.st);
    }
};

Player.prototype.onFileData = function (data, start, end, seq) {
    //this.logger.logInfo("Got data bytes=" + start + "-" + end + ".");
    this.downloading = false;

    if (this.playerState == playerStateIdle) {
        return;
    }

    if (seq != this.downloadSeqNo) {
        return;  // Old data.
    }

    if (this.playerState == playerStatePausing) {
        if (this.seeking) {
            setTimeout(() => {
                this.resume();
            }, 0);
        } else {
            return;
        }
    }

    var len = end - start + 1;
    this.fileInfo.offset += len;

    var objData = {
        t: kFeedDataReq,
        d: data
    };
    this.decodeWorker.postMessage(objData, [objData.d]);

    switch (this.decoderState) {
        case decoderStateIdle:
            this.onFileDataUnderDecoderIdle();
            break;
        case decoderStateInitializing:
            this.onFileDataUnderDecoderInitializing();
            break;
        case decoderStateReady:
            this.onFileDataUnderDecoderReady();
            break;
    }

    if (this.urgent) {
        setTimeout(() => {
            this.downloadOneChunk();
        }, 0);
    }
};

Player.prototype.onFileDataUnderDecoderIdle = function () {
    if (this.fileInfo.offset >= this.waitHeaderLength) {
        this.logger.logInfo("Opening decoder.");
        this.decoderState = decoderStateInitializing;
        var req = {
            t: kOpenDecoderReq
        };
        this.decodeWorker.postMessage(req);
    }

    this.downloadOneChunk();
};

Player.prototype.onFileDataUnderDecoderInitializing = function () {
    this.downloadOneChunk();
};

Player.prototype.onFileDataUnderDecoderReady = function () {
    //this.downloadOneChunk();
};

Player.prototype.onInitDecoder = function (objData) {
    if (this.playerState == playerStateIdle) {
        return;
    }

    this.logger.logInfo("Init decoder response " + objData.e + ".");
    if (objData.e == 0) {
        this.downloadOneChunk();
    } else {
        this.reportPlayError(objData.e);
    }
};

Player.prototype.onOpenDecoder = function (objData) {
    if (this.playerState == playerStateIdle) {
        return;
    }

    this.logger.logInfo("Open decoder response " + objData.e + ".");
    if (objData.e == 0) {
        this.onVideoParam(objData.v);
        this.onAudioParam(objData.a);
        this.decoderState = decoderStateReady;
        this.logger.logInfo("Decoder ready now.");
        this.startDecoding();
    } else {
        this.reportPlayError(objData.e);
    }
};

Player.prototype.onVideoParam = function (v) {
    if (this.playerState == playerStateIdle) {
        return;
    }

    this.logger.logInfo("Video param duation:" + v.d + " pixFmt:" + v.p + " width:" + v.w + " height:" + v.h + ".");
    this.duration = v.d;
    this.pixFmt = v.p;
    //this.canvas.width = v.w;
    //this.canvas.height = v.h;
    this.videoWidth = v.w;
    this.videoHeight = v.h;
    this.yLength = this.videoWidth * this.videoHeight;
    this.uvLength = (this.videoWidth / 2) * (this.videoHeight / 2);

    /*
    //var playCanvasContext = playCanvas.getContext("2d"); //If get 2d, webgl will be disabled.
    this.webglPlayer = new WebGLPlayer(this.canvas, {
        preserveDrawingBuffer: false
    });
    */

    if (this.timeTrack) {
        this.timeTrack.min = 0;
        this.timeTrack.max = this.duration;
        this.timeTrack.value = 0;
        this.displayDuration = this.formatTime(this.duration / 1000);
    }

    var byteRate = 1000 * this.fileInfo.size / this.duration;
    var targetSpeed = downloadSpeedByteRateCoef * byteRate;
    var chunkPerSecond = targetSpeed / this.fileInfo.chunkSize;
    this.chunkInterval = 1000 / chunkPerSecond;

    this.startDownloadTimer();

    this.logger.logInfo("Byte rate:" + byteRate + " target speed:" + targetSpeed + " chunk interval:" + this.chunkInterval + ".");
};

Player.prototype.onAudioParam = function (a) {
    if (this.playerState == playerStateIdle) {
        return;
    }

    this.logger.logInfo("Audio param sampleFmt:" + a.f + " channels:" + a.c + " sampleRate:" + a.r + ".");

    var sampleFmt = a.f;
    var channels = a.c;
    var sampleRate = a.r;

    var encoding = "16bitInt";
    switch (sampleFmt) {
        case 0:
            encoding = "8bitInt";
            break;
        case 1:
            encoding = "16bitInt";
            break;
        case 2:
            encoding = "32bitInt";
            break;
        case 3:
            encoding = "32bitFloat";
            break;
        default:
            this.logger.logError("Unsupported audio sampleFmt " + sampleFmt + "!");
    }
    this.logger.logInfo("Audio encoding " + encoding + ".");

    this.pcmPlayer = new PCMPlayer({
        encoding: encoding,
        channels: channels,
        sampleRate: sampleRate,
        flushingTime: 5000
    });

    this.audioEncoding      = encoding;
    this.audioChannels      = channels;
    this.audioSampleRate    = sampleRate;
};

Player.prototype.restartAudio = function () {
    if (this.pcmPlayer) {
        this.pcmPlayer.destroy();
        this.pcmPlayer = null;
    }

    this.pcmPlayer = new PCMPlayer({
        encoding: this.audioEncoding,
        channels: this.audioChannels,
        sampleRate: this.audioSampleRate,
        flushingTime: 5000
    });
};

Player.prototype.onAudioFrame = function (frame) {
    if (this.playerState != playerStatePlaying) {
        return;
    }

    if (this.seeking) {
        this.restartAudio();
        this.startTrackTimer();
        this.hideLoading();
        this.seeking = false;
    }

    switch (this.playerState) {
        case playerStatePlaying: //Directly display audio.
            this.pcmPlayer.play(new Uint8Array(frame.d));
            break;
        case playerStatePausing: //Temp cache.
            this.audioQueue.push(new Uint8Array(frame.d));
            break;
        default:
    }
};

Player.prototype.onDecodeFinished = function (objData) {
    this.pauseDecoding();
    this.decoderState   = decoderStateFinished;
}

Player.prototype.onVideoFrame = function (frame) {
    if (this.playerState != playerStatePlaying) {
        return;
    }

    if (this.seeking) {
        this.restartAudio();
        this.startTrackTimer();
        this.hideLoading();
        this.seeking = false;
    }

    //Queue video frames for memory controlling.
    this.videoQueue.push(frame);
    if (this.videoQueue.length >= maxVideoFrameQueueSize) {
        if (this.decoding) {
            //this.logger.logInfo("Image queue size >= " + maxVideoFrameQueueSize + ", pause decoding.");
            this.pauseDecoding();
        }
    }
};

Player.prototype.onSeekToRsp = function (ret) {
    if (ret != 0) {
        this.justSeeked = false;
        this.seeking = false;
    }
};

Player.prototype.onRequestData = function (offset) {
    if (this.justSeeked) {
        this.logger.logInfo("Request data " + offset);
        if (offset >= 0 && offset < this.fileInfo.size) {
            this.fileInfo.offset = offset;
        } 
        this.startDownloadTimer();
        //this.restartAudio();
        this.justSeeked = false;
    }
};

Player.prototype.displayLoop = function() {
    requestAnimationFrame(this.displayLoop.bind(this));
    if (this.playerState != playerStatePlaying) {
        return;
    }

    if (this.videoQueue.length == 0) {
        return;
    }

    var frame = this.videoQueue[0];
    var audioCurTs = this.pcmPlayer.getTimestamp();
    var audioTimestamp = audioCurTs + this.beginTimeOffset;
    var delay = frame.s - audioTimestamp;

    //this.logger.logInfo("displayLoop delay=" + delay + "=" + " " + frame.s  + " - (" + audioCurTs  + " + " + this.beginTimeOffset + ")" + "->" + audioTimestamp);

    if (audioTimestamp <= 0 || delay <= 0) {
        var data = new Uint8Array(frame.d);
        this.renderVideoFrame(data);

        this.videoQueue.shift();

        if (this.videoQueue.length < maxVideoFrameQueueSize / 2) {
            if (!this.decoding) {
                //this.logger.logInfo("Image queue size < " + maxVideoFrameQueueSize / 2 + ", restart decoding.");
                this.startDecoding();
            }
        }

        if (this.videoQueue.length == 0) {
            if (this.decoderState == decoderStateFinished) {
                this.reportPlayError(1, 0, "Finished");
                this.stop();
            }
        }
    }
};

Player.prototype.renderVideoFrame = function (data) {
    this.webglPlayer.renderFrame(data, this.videoWidth, this.videoHeight, this.yLength, this.uvLength);
};

Player.prototype.downloadOneChunk = function () {
    if (this.downloading) {
        return;
    }

    var start = this.fileInfo.offset;
    if (start >= this.fileInfo.size) {
        this.logger.logError("Reach file end.");
        this.stopDownloadTimer();
        return;
    }

    var end = this.fileInfo.offset + this.fileInfo.chunkSize - 1;
    if (end >= this.fileInfo.size) {
        end = this.fileInfo.size - 1;
    }

    var len = end - start + 1;
    if (len > this.fileInfo.chunkSize) {
        console.log("Error: request len:" + len + " > chunkSize:" + this.fileInfo.chunkSize);
        return;
    }

    var req = {
        t: kDownloadFileReq,
        u: this.fileInfo.url,
        s: start,
        e: end,
        q: this.downloadSeqNo
    };
    this.downloadWorker.postMessage(req);
    this.downloading = true;
};

Player.prototype.startDownloadTimer = function () {
    var self = this;
    this.downloadSeqNo++;
    this.downloadTimer = setInterval(function () {
        self.downloadOneChunk();
    }, this.chunkInterval);
};

Player.prototype.stopDownloadTimer = function () {
    if (this.downloadTimer != null) {
        clearInterval(this.downloadTimer);
        this.downloadTimer = null;
        this.logger.logInfo("Download timer stopped.");
    }
    this.downloading = false;
};

Player.prototype.startTrackTimer = function () {
    var self = this;
    this.trackTimer = setInterval(function () {
        self.updateTrackTime();
    }, this.trackTimerInterval);
};

Player.prototype.stopTrackTimer = function () {
    if (this.trackTimer != null) {
        clearInterval(this.trackTimer);
        this.trackTimer = null;
    }
};

Player.prototype.updateTrackTime = function () {
    if (this.playerState == playerStatePlaying && this.pcmPlayer) {
        var currentPlayTime = this.pcmPlayer.getTimestamp() + this.beginTimeOffset;
        if (this.timeTrack) {
            this.timeTrack.value = 1000 * currentPlayTime;
        }

        if (this.timeLabel) {
            this.timeLabel.innerHTML = this.formatTime(currentPlayTime) + "/" + this.displayDuration;
        }
    }
};

Player.prototype.startDecoding = function () {
    var req = {
        t: kStartDecodingReq,
        i: this.decodeInterval
    };
    this.decodeWorker.postMessage(req);
    this.decoding = true;
};

Player.prototype.pauseDecoding = function () {
    var req = {
        t: kPauseDecodingReq
    };
    this.decodeWorker.postMessage(req);
    this.decoding = false;
};

Player.prototype.formatTime = function (s) {
    var h = Math.floor(s / 3600) < 10 ? '0' + Math.floor(s / 3600) : Math.floor(s / 3600);
    var m = Math.floor((s / 60 % 60)) < 10 ? '0' + Math.floor((s / 60 % 60)) : Math.floor((s / 60 % 60));
    var s = Math.floor((s % 60)) < 10 ? '0' + Math.floor((s % 60)) : Math.floor((s % 60));
    return result = h + ":" + m + ":" + s;
};

Player.prototype.reportPlayError = function (error, status, message) {
    var e = {
        error: error || 0,
        status: status || 0,
        message: message
    };

    if (this.callback) {
        this.callback(e);
    }
};

Player.prototype.setLoadingDiv = function (loadingDiv) {
    this.loadingDiv = loadingDiv;
}

Player.prototype.hideLoading = function () {
    if (this.loadingDiv != null) {
        loading.style.display = "none";
    }
};

Player.prototype.showLoading = function () {
    if (this.loadingDiv != null) {
        loading.style.display = "block";
    }
};
