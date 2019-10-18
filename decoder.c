#include <stdio.h>
#include <sys/time.h>
#include <sys/timeb.h>
#include <unistd.h>

typedef void(*VideoCallback)(unsigned char *buff, int size, double timestamp);
typedef void(*AudioCallback)(unsigned char *buff, int size, double timestamp);
typedef void(*RequestCallback)(int offset);

#ifdef __cplusplus
extern "C" {
#endif

#include "libavcodec/avcodec.h"
#include "libavformat/avformat.h"
//#include "libswscale/swscale.h"

#define MIN(X, Y)  ((X) < (Y) ? (X) : (Y))

const int kCustomIoBufferSize = 32 * 1024;
const int kInitialPcmBufferSize = 128 * 1024;

typedef enum ErrorCode {
    kErrorCode_Success = 0,
    kErrorCode_Invalid_Param,
    kErrorCode_Invalid_State,
    kErrorCode_Invalid_Data,
    kErrorCode_Invalid_Format,
    kErrorCode_NULL_Pointer,
    kErrorCode_Open_File_Error,
    kErrorCode_Eof,
    kErrorCode_FFmpeg_Error,
    kErrorCode_Old_Frame
}ErrorCode;

typedef enum LogLevel{
    kLogLevel_None, //Not logging.
    kLogLevel_Core, //Only logging core module(without ffmpeg).
    kLogLevel_All   //Logging all, with ffmpeg.
}LogLevel;

typedef struct WebDecoder {
    AVFormatContext *avformatContext;
    AVCodecContext *videoCodecContext;
    AVCodecContext *audioCodecContext;
    AVFrame *avFrame;
    int videoStreamIdx;
    int audioStreamIdx;
    VideoCallback videoCallback;
    AudioCallback audioCallback;
    RequestCallback requestCallback;
    unsigned char *yuvBuffer;
    //unsigned char *rgbBuffer;
    unsigned char *pcmBuffer;
    int currentPcmBufferSize;
    int videoBufferSize;
    int videoSize;
    //struct SwsContext* swsCtx;
    unsigned char *customIoBuffer;
    FILE *fp;
    char fileName[64];
    int64_t fileSize;
    int64_t fileReadPos;
    int64_t fileWritePos;
    int64_t lastRequestOffset;
    double beginTimeOffset;
    int accurateSeek;
}WebDecoder;

WebDecoder *decoder = NULL;
LogLevel logLevel = kLogLevel_None;

unsigned long getTickCount() {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return ts.tv_sec * (unsigned long)1000 + ts.tv_nsec / 1000000;
}

void simpleLog(const char* format, ...) {
    if (logLevel == kLogLevel_None) {
        return;
    }

    char szBuffer[1024] = { 0 };
    char szTime[32]		= { 0 };
    char *p				= NULL;
    int prefixLength	= 0;
    const char *tag		= "Core";
    struct tm tmTime;
    struct timeb tb;

    ftime(&tb);
    localtime_r(&tb.time, &tmTime);

    if (1) {
        int tmYear		= tmTime.tm_year + 1900;
        int tmMon		= tmTime.tm_mon + 1;
        int tmMday		= tmTime.tm_mday;
        int tmHour		= tmTime.tm_hour;
        int tmMin		= tmTime.tm_min;
        int tmSec		= tmTime.tm_sec;
        int tmMillisec	= tb.millitm;
        sprintf(szTime, "%d-%d-%d %d:%d:%d.%d", tmYear, tmMon, tmMday, tmHour, tmMin, tmSec, tmMillisec);
    }

    prefixLength = sprintf(szBuffer, "[%s][%s][DT] ", szTime, tag);
    p = szBuffer + prefixLength;
    
    if (1) {
        va_list ap;
        va_start(ap, format);
        vsnprintf(p, 1024 - prefixLength, format, ap);
        va_end(ap);
    }

    printf("%s\n", szBuffer);
}

void ffmpegLogCallback(void* ptr, int level, const char* fmt, va_list vl) {
    static int printPrefix	= 1;
    static int count		= 0;
    static char prev[1024]	= { 0 };
    char line[1024]			= { 0 };
    static int is_atty;
    AVClass* avc = ptr ? *(AVClass**)ptr : NULL;
    if (level > AV_LOG_DEBUG) {
        return;
    }

    line[0] = 0;

    if (printPrefix && avc) {
        if (avc->parent_log_context_offset) {
            AVClass** parent = *(AVClass***)(((uint8_t*)ptr) + avc->parent_log_context_offset);
            if (parent && *parent) {
                snprintf(line, sizeof(line), "[%s @ %p] ", (*parent)->item_name(parent), parent);
            }
        }
        snprintf(line + strlen(line), sizeof(line) - strlen(line), "[%s @ %p] ", avc->item_name(ptr), ptr);
    }

    vsnprintf(line + strlen(line), sizeof(line) - strlen(line), fmt, vl);
    line[strlen(line) + 1] = 0;
    simpleLog("%s", line);
}

int openCodecContext(AVFormatContext *fmtCtx, enum AVMediaType type, int *streamIdx, AVCodecContext **decCtx) {
    int ret = 0;
    do {
        int streamIndex		= -1;
        AVStream *st		= NULL;
        AVCodec *dec		= NULL;
        AVDictionary *opts	= NULL;

        ret = av_find_best_stream(fmtCtx, type, -1, -1, NULL, 0);
        if (ret < 0) {
            simpleLog("Could not find %s stream.", av_get_media_type_string(type));
            break;
        }

        streamIndex = ret;
        st = fmtCtx->streams[streamIndex];

        dec = avcodec_find_decoder(st->codecpar->codec_id);
        if (!dec) {
            simpleLog("Failed to find %s codec %d.", av_get_media_type_string(type), st->codecpar->codec_id);
            ret = AVERROR(EINVAL);
            break;
        }

        *decCtx = avcodec_alloc_context3(dec);
        if (!*decCtx) {
            simpleLog("Failed to allocate the %s codec context.", av_get_media_type_string(type));
            ret = AVERROR(ENOMEM);
            break;
        }

        if ((ret = avcodec_parameters_to_context(*decCtx, st->codecpar)) != 0) {
            simpleLog("Failed to copy %s codec parameters to decoder context.", av_get_media_type_string(type));
            break;
        }

        av_dict_set(&opts, "refcounted_frames", "0", 0);

        if ((ret = avcodec_open2(*decCtx, dec, NULL)) != 0) {
            simpleLog("Failed to open %s codec.", av_get_media_type_string(type));
            break;
        }

        *streamIdx = streamIndex;
        avcodec_flush_buffers(*decCtx);
    } while (0);

    return ret;
}

void closeCodecContext(AVFormatContext *fmtCtx, AVCodecContext *decCtx, int streamIdx) {
    do {
        if (fmtCtx == NULL || decCtx == NULL) {
            break;
        }

        if (streamIdx < 0 || streamIdx >= fmtCtx->nb_streams) {
            break;
        }

        fmtCtx->streams[streamIdx]->discard = AVDISCARD_ALL;
        avcodec_close(decCtx);
    } while (0);
}

ErrorCode copyYuvData(AVFrame *frame, unsigned char *buffer, int width, int height) {
    ErrorCode ret		= kErrorCode_Success;
    unsigned char *src	= NULL;
    unsigned char *dst	= buffer;
    int i = 0;
    do {
        if (frame == NULL || buffer == NULL) {
            ret = kErrorCode_Invalid_Param;
            break;
        }

        if (!frame->data[0] || !frame->data[1] || !frame->data[2]) {
            ret = kErrorCode_Invalid_Param;
            break;
        }

        for (i = 0; i < height; i++) {
            src = frame->data[0] + i * frame->linesize[0];
            memcpy(dst, src, width);
            dst += width;
        }

        for (i = 0; i < height / 2; i++) {
            src = frame->data[1] + i * frame->linesize[1];
            memcpy(dst, src, width / 2);
            dst += width / 2;
        }

        for (i = 0; i < height / 2; i++) {
            src = frame->data[2] + i * frame->linesize[2];
            memcpy(dst, src, width / 2);
            dst += width / 2;
        }
    } while (0);
    return ret;	
}

/*
ErrorCode yuv420pToRgb32(unsigned char *yuvBuff, unsigned char *rgbBuff, int width, int height) {
    ErrorCode ret = kErrorCode_Success;
    AVPicture yuvPicture, rgbPicture;
    uint8_t *ptmp = NULL;
    do {
        if (yuvBuff == NULL || rgbBuff == NULL) {
            ret = kErrorCode_Invalid_Param
            break;
        }

        if (decoder == NULL || decoder->swsCtx == NULL) {
            ret = kErrorCode_Invalid_Param
            break;
        }

        
        avpicture_fill(&yuvPicture, yuvBuff, AV_PIX_FMT_YUV420P, width, height);
        avpicture_fill(&rgbPicture, rgbBuff, AV_PIX_FMT_RGB32, width, height);

        ptmp = yuvPicture.data[1];
        yuvPicture.data[1] = yuvPicture.data[2];
        yuvPicture.data[2] = ptmp;

        sws_scale(decoder->swsCtx, yuvPicture.data, yuvPicture.linesize, 0, height, rgbPicture.data, rgbPicture.linesize);
    } while (0);
    return ret;
}
*/

int roundUp(int numToRound, int multiple) {
    return (numToRound + multiple - 1) & -multiple;
}

ErrorCode processDecodedVideoFrame(AVFrame *frame) {
    ErrorCode ret = kErrorCode_Success;
    double timestamp = 0.0f;
    do {
        if (frame == NULL ||
            decoder->videoCallback == NULL ||
            decoder->yuvBuffer == NULL ||
            decoder->videoBufferSize <= 0) {
            ret = kErrorCode_Invalid_Param;
            break;
        }

        if (decoder->videoCodecContext->pix_fmt != AV_PIX_FMT_YUV420P) {
            simpleLog("Not YUV420P, but unsupported format %d.", decoder->videoCodecContext->pix_fmt);
            ret = kErrorCode_Invalid_Format;
            break;
        }

        ret = copyYuvData(frame, decoder->yuvBuffer, decoder->videoCodecContext->width, decoder->videoCodecContext->height);
        if (ret != kErrorCode_Success) {
            break;
        }

        /*
        ret = yuv420pToRgb32(decoder->yuvBuffer, decoder->rgbBuffer, decoder->videoCodecContext->width, decoder->videoCodecContext->height);
        if (ret != kErrorCode_Success) {
            break;
        }
        */

        timestamp = (double)frame->pts * av_q2d(decoder->avformatContext->streams[decoder->videoStreamIdx]->time_base);

        if (decoder->accurateSeek && timestamp < decoder->beginTimeOffset) {
            //simpleLog("video timestamp %lf < %lf", timestamp, decoder->beginTimeOffset);
            ret = kErrorCode_Old_Frame;
            break;
        }
        decoder->videoCallback(decoder->yuvBuffer, decoder->videoSize, timestamp);
    } while (0);
    return ret;
}

ErrorCode processDecodedAudioFrame(AVFrame *frame) {
    ErrorCode ret       = kErrorCode_Success;
    int sampleSize      = 0;
    int audioDataSize   = 0;
    int targetSize      = 0;
    int offset          = 0;
    int i               = 0;
    int ch              = 0;
    double timestamp    = 0.0f;
    do {
        if (frame == NULL) {
            ret = kErrorCode_Invalid_Param;
            break;
        }

        sampleSize = av_get_bytes_per_sample(decoder->audioCodecContext->sample_fmt);
        if (sampleSize < 0) {
            simpleLog("Failed to calculate data size.");
            ret = kErrorCode_Invalid_Data;
            break;
        }

        if (decoder->pcmBuffer == NULL) {
            decoder->pcmBuffer = (unsigned char*)av_mallocz(kInitialPcmBufferSize);
            decoder->currentPcmBufferSize = kInitialPcmBufferSize;
            simpleLog("Initial PCM buffer size %d.", decoder->currentPcmBufferSize);
        }

        audioDataSize = frame->nb_samples * decoder->audioCodecContext->channels * sampleSize;
        if (decoder->currentPcmBufferSize < audioDataSize) {
            targetSize = roundUp(audioDataSize, 4);
            simpleLog("Current PCM buffer size %d not sufficient for data size %d, round up to target %d.",
                decoder->currentPcmBufferSize,
                audioDataSize,
                targetSize);
            decoder->currentPcmBufferSize = targetSize;
            av_free(decoder->pcmBuffer);
            decoder->pcmBuffer = (unsigned char*)av_mallocz(decoder->currentPcmBufferSize);
        }

        for (i = 0; i < frame->nb_samples; i++) {
            for (ch = 0; ch < decoder->audioCodecContext->channels; ch++) {
                memcpy(decoder->pcmBuffer + offset, frame->data[ch] + sampleSize * i, sampleSize);
                offset += sampleSize;
            }
        }

        timestamp = (double)frame->pts * av_q2d(decoder->avformatContext->streams[decoder->audioStreamIdx]->time_base);

        if (decoder->accurateSeek && timestamp < decoder->beginTimeOffset) {
            //simpleLog("audio timestamp %lf < %lf", timestamp, decoder->beginTimeOffset);
            ret = kErrorCode_Old_Frame;
            break;
        }
        if (decoder->audioCallback != NULL) {
            decoder->audioCallback(decoder->pcmBuffer, audioDataSize, timestamp);
        }
    } while (0);
    return ret;
}

ErrorCode decodePacket(AVPacket *pkt, int *decodedLen) {
    int ret = 0;
    int isVideo = 0;
    AVCodecContext *codecContext = NULL;

    if (pkt == NULL || decodedLen == NULL) {
        simpleLog("decodePacket invalid param.");
        return kErrorCode_Invalid_Param;
    }

    *decodedLen = 0;

    if (pkt->stream_index == decoder->videoStreamIdx) {
        codecContext = decoder->videoCodecContext;
        isVideo = 1;
    } else if (pkt->stream_index == decoder->audioStreamIdx) {
        codecContext = decoder->audioCodecContext;
        isVideo = 0;
    } else {
        return kErrorCode_Invalid_Data;
    }

    ret = avcodec_send_packet(codecContext, pkt);
    if (ret < 0) {
        simpleLog("Error sending a packet for decoding %d.", ret);
        return kErrorCode_FFmpeg_Error;
    }

    while (ret >= 0) {
        ret = avcodec_receive_frame(codecContext, decoder->avFrame);
        if (ret == AVERROR(EAGAIN)) {
            return kErrorCode_Success;
        } else if (ret == AVERROR_EOF) {
            return kErrorCode_Eof;
        } else if (ret < 0) {
            simpleLog("Error during decoding %d.", ret);
            return kErrorCode_FFmpeg_Error;
        } else {
            int r = isVideo ? processDecodedVideoFrame(decoder->avFrame) : processDecodedAudioFrame(decoder->avFrame);
            if (r == kErrorCode_Old_Frame) {
                return r;
            }
        }
    }

    *decodedLen = pkt->size;
    return kErrorCode_Success;
}

int readCallback(void *opaque, uint8_t *data, int len) {
    //simpleLog("readCallback %d.", len);
    int32_t ret			= -1;
    int availableBytes	= 0;
    int canReadLen		= 0;
    do {
        if (decoder == NULL || decoder->fp == NULL) {
            break;
        }

        if (data == NULL || len <= 0) {
            break;
        }		

        availableBytes = decoder->fileWritePos - decoder->fileReadPos;
        if (availableBytes <= 0) {
            break;
        }

        fseek(decoder->fp, decoder->fileReadPos, SEEK_SET);
        canReadLen = MIN(availableBytes, len);
        fread(data, canReadLen, 1, decoder->fp);
        decoder->fileReadPos += canReadLen;
        ret = canReadLen;
    } while (0);
    //simpleLog("readCallback ret %d.", ret);
    return ret;
}

int64_t seekCallback(void *opaque, int64_t offset, int whence) {
    int64_t ret         = -1;
    int64_t pos         = -1;
    int64_t req_pos     = -1;
    //simpleLog("seekCallback %lld %d.", offset, whence);
    do {
        if (decoder == NULL || decoder->fp == NULL) {
            break;
        }

        if (whence == AVSEEK_SIZE) {
            ret = decoder->fileSize;
            break;
        }

        if (whence != SEEK_END && whence != SEEK_SET && whence != SEEK_CUR) {
            break;
        }

        ret = fseek(decoder->fp, (long)offset, whence);
        if (ret == -1) {
            break;
        }

        pos = (int64_t)ftell(decoder->fp);
        if (pos < decoder->lastRequestOffset || pos > decoder->fileWritePos) {
            decoder->lastRequestOffset  = pos;
            decoder->fileReadPos        = pos;
            decoder->fileWritePos       = pos;
            req_pos                     = pos;
            ret                         = -1;  // Forcing not to call read at once.
            decoder->requestCallback(pos);
            simpleLog("Will request %lld and return %lld.", pos, ret);
            break;
        }

        decoder->fileReadPos = pos;
        ret = pos;
    } while (0);
    //simpleLog("seekCallback return %lld.", ret);

    if (decoder != NULL && decoder->requestCallback != NULL) {
        decoder->requestCallback(req_pos);
    }
    return ret;
}

//////////////////////////////////Export methods////////////////////////////////////////
ErrorCode initDecoder(int fileSize, int logLv) {
    ErrorCode ret = kErrorCode_Success;
    do {
        //Log level.
        logLevel = logLv;

        if (decoder != NULL) {
            break;
        }

        decoder = (WebDecoder *)av_mallocz(sizeof(WebDecoder));
        decoder->fileSize = fileSize;
        sprintf(decoder->fileName, "tmp-%lu.mp4", getTickCount());
        decoder->fp = fopen(decoder->fileName, "wb+");
        if (decoder->fp == NULL) {
            simpleLog("Open file %s failed, err: %d.", decoder->fileName, errno);
            ret = kErrorCode_Open_File_Error;
            av_free(decoder);
            decoder = NULL;
        }
    } while (0);
    simpleLog("Decoder initialized %d.", ret);
    return ret;
}

ErrorCode uninitDecoder() {
    if (decoder != NULL) {
        if (decoder->fp != NULL) {
            fclose(decoder->fp);
            decoder->fp = NULL;
        }

        remove(decoder->fileName);
        av_freep(&decoder);
    }

    av_log_set_callback(NULL);

    simpleLog("Decoder uninitialized.");
    return kErrorCode_Success;
}

ErrorCode openDecoder(int *paramArray, int paramCount, long videoCallback, long audioCallback, long requestCallback) {
    ErrorCode ret = kErrorCode_Success;
    int r = 0;
    int i = 0;
    int params[7] = { 0 };
    do {
        simpleLog("Opening decoder.");

        av_register_all();
        avcodec_register_all();

        if (logLevel == kLogLevel_All) {
            av_log_set_callback(ffmpegLogCallback);
        }
        
        decoder->avformatContext = avformat_alloc_context();
        decoder->customIoBuffer = (unsigned char*)av_mallocz(kCustomIoBufferSize);

        AVIOContext* ioContext = avio_alloc_context(
            decoder->customIoBuffer,
            kCustomIoBufferSize,
            0,
            NULL,
            readCallback,
            NULL,
            seekCallback);
        if (ioContext == NULL) {
            ret = kErrorCode_FFmpeg_Error;
            simpleLog("avio_alloc_context failed.");
            break;
        }

        decoder->avformatContext->pb = ioContext;
        decoder->avformatContext->flags = AVFMT_FLAG_CUSTOM_IO;

        r = avformat_open_input(&decoder->avformatContext, NULL, NULL, NULL);
        if (r != 0) {
            ret = kErrorCode_FFmpeg_Error;
            char err_info[32] = { 0 };
            av_strerror(ret, err_info, 32);
            simpleLog("avformat_open_input failed %d %s.", ret, err_info);
            break;
        }
        
        simpleLog("avformat_open_input success.");

        r = avformat_find_stream_info(decoder->avformatContext, NULL);
        if (r != 0) {
            ret = kErrorCode_FFmpeg_Error;
            simpleLog("av_find_stream_info failed %d.", ret);
            break;
        }

        simpleLog("avformat_find_stream_info success.");

        for (i = 0; i < decoder->avformatContext->nb_streams; i++) {
            decoder->avformatContext->streams[i]->discard = AVDISCARD_DEFAULT;
        }

        r = openCodecContext(
            decoder->avformatContext,
            AVMEDIA_TYPE_VIDEO,
            &decoder->videoStreamIdx,
            &decoder->videoCodecContext);
        if (r != 0) {
            ret = kErrorCode_FFmpeg_Error;
            simpleLog("Open video codec context failed %d.", ret);
            break;
        }

        simpleLog("Open video codec context success, video stream index %d %x.",
            decoder->videoStreamIdx, (unsigned int)decoder->videoCodecContext);

        simpleLog("Video stream index:%d pix_fmt:%d resolution:%d*%d.",
            decoder->videoStreamIdx,
            decoder->videoCodecContext->pix_fmt,
            decoder->videoCodecContext->width,
            decoder->videoCodecContext->height);

        r = openCodecContext(
            decoder->avformatContext,
            AVMEDIA_TYPE_AUDIO,
            &decoder->audioStreamIdx,
            &decoder->audioCodecContext);
        if (r != 0) {
            ret = kErrorCode_FFmpeg_Error;
            simpleLog("Open audio codec context failed %d.", ret);
            break;
        }

        simpleLog("Open audio codec context success, audio stream index %d %x.",
            decoder->audioStreamIdx, (unsigned int)decoder->audioCodecContext);

        simpleLog("Audio stream index:%d sample_fmt:%d channel:%d, sample rate:%d.",
            decoder->audioStreamIdx,
            decoder->audioCodecContext->sample_fmt,
            decoder->audioCodecContext->channels,
            decoder->audioCodecContext->sample_rate);

        av_seek_frame(decoder->avformatContext, -1, 0, AVSEEK_FLAG_BACKWARD);

        /* For RGB Renderer(2D WebGL).
        decoder->swsCtx = sws_getContext(
            decoder->videoCodecContext->width,
            decoder->videoCodecContext->height,
            decoder->videoCodecContext->pix_fmt, 
            decoder->videoCodecContext->width,
            decoder->videoCodecContext->height,
            AV_PIX_FMT_RGB32,
            SWS_BILINEAR, 
            0, 
            0, 
            0);
        if (decoder->swsCtx == NULL) {
            simpleLog("sws_getContext failed.");
            ret = kErrorCode_FFmpeg_Error;
            break;
        }
        */
        
        decoder->videoSize = avpicture_get_size(
            decoder->videoCodecContext->pix_fmt,
            decoder->videoCodecContext->width,
            decoder->videoCodecContext->height);

        decoder->videoBufferSize = 3 * decoder->videoSize;
        decoder->yuvBuffer = (unsigned char *)av_mallocz(decoder->videoBufferSize);
        decoder->avFrame = av_frame_alloc();
        
        params[0] = 1000 * (decoder->avformatContext->duration + 5000) / AV_TIME_BASE;
        params[1] = decoder->videoCodecContext->pix_fmt;
        params[2] = decoder->videoCodecContext->width;
        params[3] = decoder->videoCodecContext->height;
        params[4] = decoder->audioCodecContext->sample_fmt;
        params[5] = decoder->audioCodecContext->channels;
        params[6] = decoder->audioCodecContext->sample_rate;

        enum AVSampleFormat sampleFmt = decoder->audioCodecContext->sample_fmt;
        if (av_sample_fmt_is_planar(sampleFmt)) {
            const char *packed = av_get_sample_fmt_name(sampleFmt);
            params[4] = av_get_packed_sample_fmt(sampleFmt);
        }

        if (paramArray != NULL && paramCount > 0) {
            for (int i = 0; i < paramCount; ++i) {
                paramArray[i] = params[i];
            }
        }

        decoder->videoCallback = (VideoCallback)videoCallback;
        decoder->audioCallback = (AudioCallback)audioCallback;
        decoder->requestCallback = (RequestCallback)requestCallback;

        simpleLog("Decoder opened, duration %ds, picture size %d.", params[0], decoder->videoSize);
    } while (0);

    if (ret != kErrorCode_Success && decoder != NULL) {
        av_freep(&decoder);
    }
    return ret;
}

ErrorCode closeDecoder() {
    ErrorCode ret = kErrorCode_Success;
    do {
        if (decoder == NULL || decoder->avformatContext == NULL) {
            break;
        }

        if (decoder->videoCodecContext != NULL) {
            closeCodecContext(decoder->avformatContext, decoder->videoCodecContext, decoder->videoStreamIdx);
            decoder->videoCodecContext = NULL;
            simpleLog("Video codec context closed.");
        }

        if (decoder->audioCodecContext != NULL) {
            closeCodecContext(decoder->avformatContext, decoder->audioCodecContext, decoder->audioStreamIdx);
            decoder->audioCodecContext = NULL;
            simpleLog("Audio codec context closed.");
        }

        AVIOContext *pb = decoder->avformatContext->pb;
        if (pb != NULL) {
            if (pb->buffer != NULL) {
                av_freep(&pb->buffer);
                decoder->customIoBuffer = NULL;
            }
            av_freep(&decoder->avformatContext->pb);
            simpleLog("IO context released.");
        }

        avformat_close_input(&decoder->avformatContext);
        decoder->avformatContext = NULL;
        simpleLog("Input closed.");

        if (decoder->yuvBuffer != NULL) {
            av_freep(&decoder->yuvBuffer);
        }

        if (decoder->pcmBuffer != NULL) {
            av_freep(&decoder->pcmBuffer);
        }
        
        if (decoder->avFrame != NULL) {
            av_freep(&decoder->avFrame);
        }
        simpleLog("All buffer released.");
    } while (0);
    return ret;
}

int sendData(unsigned char *buff, int size) {
    int ret = 0;
    int64_t leftBytes = 0;
    int canWriteBytes = 0;
    do {
        if (decoder == NULL || decoder->fp == NULL) {
            ret = -1;
            break;
        }

        if (buff == NULL || size == 0) {
            ret = -2;
            break;
        }

        leftBytes = decoder->fileSize - decoder->fileWritePos;
        if (leftBytes <= 0) {
            break;
        }

        canWriteBytes = MIN(leftBytes, size);
        fseek(decoder->fp, decoder->fileWritePos, SEEK_SET);
        fwrite(buff, canWriteBytes, 1, decoder->fp);
        decoder->fileWritePos += canWriteBytes;
        ret = canWriteBytes;
    } while (0);
    return ret;
}

ErrorCode decodeOnePacket() {
    ErrorCode ret	= kErrorCode_Success;
    int decodedLen	= 0;
    int r			= 0;

    AVPacket packet;
    av_init_packet(&packet);
    do {
        if (decoder == NULL) {
            ret = kErrorCode_Invalid_State;
            break;
        }

        if (decoder->fileWritePos - decoder->fileReadPos <= 0) {
            ret = kErrorCode_Invalid_State;
            break;
        }

        packet.data = NULL;
        packet.size = 0;

        r = av_read_frame(decoder->avformatContext, &packet);
        if (r == AVERROR_EOF) {
            ret = kErrorCode_Eof;
            break;
        }

        if (r < 0 || packet.size == 0) {
            break;
        }

        do {
            ret = decodePacket(&packet, &decodedLen);
            if (ret != kErrorCode_Success) {
                break;
            }

            if (decodedLen <= 0) {
                break;
            }

            packet.data += decodedLen;
            packet.size -= decodedLen;
        } while (packet.size > 0);
    } while (0);
    av_packet_unref(&packet);
    return ret;
}

ErrorCode seekTo(int ms, int accurateSeek) {
    int ret = 0;
    int64_t pts = (int64_t)ms * 1000;
    decoder->accurateSeek = accurateSeek;
    ret = avformat_seek_file(decoder->avformatContext,
                                 -1,
                                 INT64_MIN,
                                 pts,
                                 pts,
                                 AVSEEK_FLAG_BACKWARD);
    simpleLog("Native seek to %d return %d %d.", ms, ret, decoder->accurateSeek);
    if (ret == -1) {
        return kErrorCode_FFmpeg_Error;
    } else {
        avcodec_flush_buffers(decoder->videoCodecContext);
        avcodec_flush_buffers(decoder->audioCodecContext);

        // Trigger seek callback
        AVPacket packet;
        av_init_packet(&packet);
        av_read_frame(decoder->avformatContext, &packet);

        decoder->beginTimeOffset = (double)ms / 1000;
        return kErrorCode_Success;
    }
}

int main() {
    //simpleLog("Native loaded.");
    return 0;
}

#ifdef __cplusplus
}
#endif
