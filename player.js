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
const maxBufferTimeLength       = 1.0;
const downloadSpeedByteRateCoef = 2.0;

String.prototype.startWith = function(str) {
    var reg = new RegExp("^" + str);
    return reg.test(this);
};

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
    this.videoRendererTimer = null;
    this.downloadTimer      = null;
    this.chunkInterval      = 200;
    this.downloadSeqNo      = 0;
    this.downloading        = false;
    this.downloadProto      = kProtoHttp;
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
    this.seekWaitLen        = 524288; // Default wait for 512K, will be updated in onVideoParam.
    this.seekReceivedLen    = 0;
    this.loadingDiv         = null;
    this.buffering          = false;
    this.frameBuffer        = [];
    this.isStream           = false;
    this.streamReceivedLen  = 0;
    this.firstAudioFrame    = true;
    this.fetchController    = null;
    this.streamPauseParam   = null;
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
                self.onRequestData(objData.o, objData.a);
                break;
            case kSeekToRsp:
                self.onSeekToRsp(objData.r);
                break;
        }
    }
};

Player.prototype.play = function (url, canvas, callback, waitHeaderLength, isStream) {
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

        if (url.startWith("ws://") || url.startWith("wss://")) {
            this.downloadProto = kProtoWebsocket;
        } else {
            this.downloadProto = kProtoHttp;
        }

        this.fileInfo = new FileInfo(url);
        this.canvas = canvas;
        this.callback = callback;
        this.waitHeaderLength = waitHeaderLength || this.waitHeaderLength;
        this.playerState = playerStatePlaying;
        this.isStream = isStream;
        this.startTrackTimer();
        this.displayLoop();

        //var playCanvasContext = playCanvas.getContext("2d"); //If get 2d, webgl will be disabled.
        this.webglPlayer = new WebGLPlayer(this.canvas, {
            preserveDrawingBuffer: false
        });

        if (!this.isStream) {
            var req = {
                t: kGetFileInfoReq,
                u: url,
                p: this.downloadProto
            };
            this.downloadWorker.postMessage(req);
        } else {
            this.requestStream(url);
            this.onGetFileInfo({
                sz: -1,
                st: 200
            });
        }

        var self = this;
        this.registerVisibilityEvent(function(visible) {
            if (visible) {
                self.resume();
            } else {
                self.pause();
            }
        });

        this.buffering = true;
        this.showLoading();
    } while (false);

    return ret;
};

Player.prototype.pauseStream = function () {
    if (this.playerState != playerStatePlaying) {
        var ret = {
            e: -1,
            m: "Not playing"
        };
        return ret;
    }

    this.streamPauseParam = {
        url: this.fileInfo.url,
        canvas: this.canvas,
        callback: this.callback,
        waitHeaderLength: this.waitHeaderLength
    }

    this.logger.logInfo("Stop in stream pause.");
    this.stop();

    var ret = {
        e: 0,
        m: "Success"
    };

    return ret;
}

Player.prototype.pause = function () {
    if (this.isStream) {
        return this.pauseStream();
    }

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
    if (this.pcmPlayer) {
        this.pcmPlayer.pause();
    }

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

Player.prototype.resumeStream = function () {
    if (this.playerState != playerStateIdle || !this.streamPauseParam) {
        var ret = {
            e: -1,
            m: "Not pausing"
        };
        return ret;
    }

    this.logger.logInfo("Play in stream resume.");
    this.play(this.streamPauseParam.url,
              this.streamPauseParam.canvas,
              this.streamPauseParam.callback,
              this.streamPauseParam.waitHeaderLength,
              true);
    this.streamPauseParam = null;

    var ret = {
        e: 0,
        m: "Success"
    };

    return ret;
}

Player.prototype.resume = function (fromSeek) {
    if (this.isStream) {
        return this.resumeStream();
    }

    this.logger.logInfo("Resume.");

    if (this.playerState != playerStatePausing) {
        var ret = {
            e: -1,
            m: "Not pausing"
        };
        return ret;
    }

    if (!fromSeek) {
        //Resume audio context.
        this.pcmPlayer.resume();
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
    this.hideLoading();

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
    this.beginTimeOffset    = 0;
    this.decoderState       = decoderStateIdle;
    this.playerState        = playerStateIdle;
    this.decoding           = false;
    this.frameBuffer        = [];
    this.buffering          = false;
    this.streamReceivedLen  = 0;
    this.firstAudioFrame    = true;
    this.urgent             = false;
    this.seekReceivedLen    = 0;

    if (this.pcmPlayer) {
        this.pcmPlayer.destroy();
        this.pcmPlayer = null;
        this.logger.logInfo("Pcm player released.");
    }

    if (this.timeTrack) {
        this.timeTrack.value = 0;
    }
    if (this.timeLabel) {
        this.timeLabel.innerHTML = this.formatTime(0) + "/" + this.displayDuration;
    }

    this.logger.logInfo("Closing decoder.");
    this.decodeWorker.postMessage({
        t: kCloseDecoderReq
    });


    this.logger.logInfo("Uniniting decoder.");
    this.decodeWorker.postMessage({
        t: kUninitDecoderReq
    });

    if (this.fetchController) {
        this.fetchController.abort();
        this.fetchController = null;
    }

    return ret;
};

Player.prototype.seekTo = function(ms) {
    if (this.isStream) {
        return;
    }

    // Pause playing.
    this.pause();

    // Stop download.
    this.stopDownloadTimer();

    // Clear frame buffer.
    this.frameBuffer.length = 0;

    // Request decoder to seek.
    this.decodeWorker.postMessage({
        t: kSeekToReq,
        ms: ms
    });

    // Reset begin time offset.
    this.beginTimeOffset = ms / 1000;
    this.logger.logInfo("seekTo beginTimeOffset " + this.beginTimeOffset);

    this.seeking = true;
    this.justSeeked = true;
    this.urgent = true;
    this.seekReceivedLen = 0;
    this.startBuffering();
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
        this.fileInfo.size = Number(info.sz);
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
            this.seekReceivedLen += data.byteLength;
            let left = this.fileInfo.size - this.fileInfo.offset;
            let seekWaitLen = Math.min(left, this.seekWaitLen);
            if (this.seekReceivedLen >= seekWaitLen) {
                this.logger.logInfo("Resume in seek now");
                setTimeout(() => {
                    this.resume(true);
                }, 0);
            }
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
    if (this.fileInfo.offset >= this.waitHeaderLength || (!this.isStream && this.fileInfo.offset == this.fileInfo.size)) {
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
        if (!this.isStream) {
            this.downloadOneChunk();
        }
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
    this.seekWaitLen = byteRate * maxBufferTimeLength * 2;
    this.logger.logInfo("Seek wait len " + this.seekWaitLen);

    if (!this.isStream) {
        this.startDownloadTimer();
    }

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

Player.prototype.bufferFrame = function (frame) {
    // If not decoding, it may be frame before seeking, should be discarded.
    if (!this.decoding) {
        return;
    }
    this.frameBuffer.push(frame);
    //this.logger.logInfo("bufferFrame " + frame.s + ", seq " + frame.q);
    if (this.getBufferTimerLength() >= maxBufferTimeLength || this.decoderState == decoderStateFinished) {
        if (this.decoding) {
            //this.logger.logInfo("Frame buffer time length >= " + maxBufferTimeLength + ", pause decoding.");
            this.pauseDecoding();
        }
        if (this.buffering) {
            this.stopBuffering();
        }
    }
}

Player.prototype.displayAudioFrame = function (frame) {
    if (this.playerState != playerStatePlaying) {
        return false;
    }

    if (this.seeking) {
        this.restartAudio();
        this.startTrackTimer();
        this.hideLoading();
        this.seeking = false;
        this.urgent = false;
    }

    if (this.isStream && this.firstAudioFrame) {
        this.firstAudioFrame = false;
        this.beginTimeOffset = frame.s;
    }

    this.pcmPlayer.play(new Uint8Array(frame.d));
    return true;
};

Player.prototype.onAudioFrame = function (frame) {
    this.bufferFrame(frame);
};

Player.prototype.onDecodeFinished = function (objData) {
    this.pauseDecoding();
    this.decoderState   = decoderStateFinished;
};

Player.prototype.getBufferTimerLength = function() {
    if (!this.frameBuffer || this.frameBuffer.length == 0) {
        return 0;
    }

    let oldest = this.frameBuffer[0];
    let newest = this.frameBuffer[this.frameBuffer.length - 1];
    return newest.s - oldest.s;
};

Player.prototype.onVideoFrame = function (frame) {
    this.bufferFrame(frame);
};

Player.prototype.displayVideoFrame = function (frame) {
    if (this.playerState != playerStatePlaying) {
        return false;
    }

    if (this.seeking) {
        this.restartAudio();
        this.startTrackTimer();
        this.hideLoading();
        this.seeking = false;
        this.urgent = false;
    }

    var audioCurTs = this.pcmPlayer.getTimestamp();
    var audioTimestamp = audioCurTs + this.beginTimeOffset;
    var delay = frame.s - audioTimestamp;

    //this.logger.logInfo("displayVideoFrame delay=" + delay + "=" + " " + frame.s  + " - (" + audioCurTs  + " + " + this.beginTimeOffset + ")" + "->" + audioTimestamp);

    if (audioTimestamp <= 0 || delay <= 0) {
        var data = new Uint8Array(frame.d);
        this.renderVideoFrame(data);
        return true;
    }
    return false;
};

Player.prototype.onSeekToRsp = function (ret) {
    if (ret != 0) {
        this.justSeeked = false;
        this.seeking = false;
    }
};

Player.prototype.onRequestData = function (offset, available) {
    if (this.justSeeked) {
        this.logger.logInfo("Request data " + offset + ", available " + available);
        if (offset == -1) {
            // Hit in buffer.
            let left = this.fileInfo.size - this.fileInfo.offset;
            if (available >= left) {
                this.logger.logInfo("No need to wait");
                this.resume();
            } else {
                this.startDownloadTimer();
            }
        } else {
            if (offset >= 0 && offset < this.fileInfo.size) {
                this.fileInfo.offset = offset;
            }
            this.startDownloadTimer();
        }

        //this.restartAudio();
        this.justSeeked = false;
    }
};

Player.prototype.displayLoop = function() {
    if (this.playerState !== playerStateIdle) {
        requestAnimationFrame(this.displayLoop.bind(this));
    }
    if (this.playerState != playerStatePlaying) {
        return;
    }

    if (this.frameBuffer.length == 0) {
        return;
    }

    if (this.buffering) {
        return;
    }

    // requestAnimationFrame may be 60fps, if stream fps too large,
    // we need to render more frames in one loop, otherwise display
    // fps won't catch up with source fps, leads to memory increasing,
    // set to 2 now.
    for (i = 0; i < 2; ++i) {
        var frame = this.frameBuffer[0];
        switch (frame.t) {
            case kAudioFrame:
                if (this.displayAudioFrame(frame)) {
                    this.frameBuffer.shift();
                }
                break;
            case kVideoFrame:
                if (this.displayVideoFrame(frame)) {
                    this.frameBuffer.shift();
                }
                break;
            default:
                return;
        }

        if (this.frameBuffer.length == 0) {
            break;
        }
    }

    if (this.getBufferTimerLength() < maxBufferTimeLength / 2) {
        if (!this.decoding) {
            //this.logger.logInfo("Buffer time length < " + maxBufferTimeLength / 2 + ", restart decoding.");
            this.startDecoding();
        }
    }

    if (this.bufferFrame.length == 0) {
        if (this.decoderState == decoderStateFinished) {
            this.reportPlayError(1, 0, "Finished");
            this.stop();
        } else {
            this.startBuffering();
        }
    }
};

Player.prototype.startBuffering = function () {
    this.buffering = true;
    this.showLoading();
    this.pause();
}

Player.prototype.stopBuffering = function () {
    this.buffering = false;
    this.hideLoading();
    this.resume();
}

Player.prototype.renderVideoFrame = function (data) {
    this.webglPlayer.renderFrame(data, this.videoWidth, this.videoHeight, this.yLength, this.uvLength);
};

Player.prototype.downloadOneChunk = function () {
    if (this.downloading || this.isStream) {
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
        q: this.downloadSeqNo,
        p: this.downloadProto
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
        i: this.urgent ? 0 : this.decodeInterval,
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

Player.prototype.registerVisibilityEvent = function (cb) {
    var hidden = "hidden";

    // Standards:
    if (hidden in document) {
        document.addEventListener("visibilitychange", onchange);
    } else if ((hidden = "mozHidden") in document) {
        document.addEventListener("mozvisibilitychange", onchange);
    } else if ((hidden = "webkitHidden") in document) {
        document.addEventListener("webkitvisibilitychange", onchange);
    } else if ((hidden = "msHidden") in document) {
        document.addEventListener("msvisibilitychange", onchange);
    } else if ("onfocusin" in document) {
        // IE 9 and lower.
        document.onfocusin = document.onfocusout = onchange;
    } else {
        // All others.
        window.onpageshow = window.onpagehide = window.onfocus = window.onblur = onchange;
    }

    function onchange (evt) {
        var v = true;
        var h = false;
        var evtMap = {
            focus:v,
            focusin:v,
            pageshow:v,
            blur:h,
            focusout:h,
            pagehide:h
        };

        evt = evt || window.event;
        var visible = v;
        if (evt.type in evtMap) {
            visible = evtMap[evt.type];
        } else {
            visible = this[hidden] ? h : v;
        }
        cb(visible);
    }

    // set the initial state (but only if browser supports the Page Visibility API)
    if( document[hidden] !== undefined ) {
        onchange({type: document[hidden] ? "blur" : "focus"});
    }
}

Player.prototype.onStreamDataUnderDecoderIdle = function (length) {
    if (this.streamReceivedLen >= this.waitHeaderLength) {
        this.logger.logInfo("Opening decoder.");
        this.decoderState = decoderStateInitializing;
        var req = {
            t: kOpenDecoderReq
        };
        this.decodeWorker.postMessage(req);
    } else {
        this.streamReceivedLen += length;
    }
};

Player.prototype.requestStream = function (url) {
    var self = this;
    this.fetchController = new AbortController();
    const signal = this.fetchController.signal;

    fetch(url, {signal}).then(async function respond(response) {
        const reader = response.body.getReader();
        reader.read().then(function processData({done, value}) {
            if (done) {
                self.logger.logInfo("Stream done.");
                return;
            }

            if (self.playerState != playerStatePlaying) {
                return;
            }

            var dataLength = value.byteLength;
            var offset = 0;
            if (dataLength > self.fileInfo.chunkSize) {
                do {
                    let len = Math.min(self.fileInfo.chunkSize, dataLength);
                    var data = value.buffer.slice(offset, offset + len);
                    dataLength -= len;
                    offset += len;
                    var objData = {
                        t: kFeedDataReq,
                        d: data
                    };
                    self.decodeWorker.postMessage(objData, [objData.d]);
                } while (dataLength > 0)
            } else {
                var objData = {
                    t: kFeedDataReq,
                    d: value.buffer
                };
                self.decodeWorker.postMessage(objData, [objData.d]);
            }

            if (self.decoderState == decoderStateIdle) {
                self.onStreamDataUnderDecoderIdle(dataLength);
            }

            return reader.read().then(processData);
        });
    }).catch(err => {
    });
};
