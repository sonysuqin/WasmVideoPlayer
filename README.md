@[TOC](基于WASM的H265 Web播放器)
# 1 背景
目前这个时间点，原生支持H265(HEVC)播放的浏览器极少，可以说基本没有，主要原因一个是H265的解码有更高的性能要求，从而换取更高的压缩率，目前大多数机器CPU软解H265的超清视频还是有点吃力，硬解兼容性又不好，另外一个原因主要是H265的专利费问题。因此H265有被各大浏览器厂商放弃的趋势，转而去支持更加开放的AV1编码，但是AV1编码的商用和普及估计还有段时间。

H265与H264相比主要的好处在于相同分辨率下降低了几乎一倍的码率，对带宽压力比较大的网站来说，使用H265可以极大削减带宽消耗(尽管可能面临专利费麻烦)，但是由于浏览器的支持问题，目前H265的播放主要在APP端实现，借助硬件解码，可以获得比较好的性能和体验。

本文相关的代码使用WASM、FFmpeg、WebGL、Web Audio等组件实现了一个简易的支持H265的Web播放器，作为探索、验证，just for fun。
# 2 代码
github地址。

# 3 依赖
## 3.1 WASM
WASM的介绍在[这里](https://webassembly.org/)，可以在浏览器里执行原生代码(例如C、C++)，要开发可以在浏览器运行的原生代码，需要安装他的[工具链](https://emscripten.org/docs/getting_started/downloads.html)，我使用的是当时最新的版本(1.38.21)。编译环境有Ubuntu、MacOS等，[这里](https://emscripten.org/docs/getting_started/downloads.html#platform-notes-installation-instructions-sdk)有介绍。
## 3.2 FFmpeg
主要使用FFmpeg来做解封装(demux)和解码(decoder)，由于使用了FFmpeg(3.3)，理论上可以播放绝大多数格式的视频，这里只针对H265编码、MP4封装，在编译时可以只按需编译最少的模块，从而得到比较小的库。

使用Emscripten编译FFmpeg主要参考下面这个网页，做了一些修改：
[https://blog.csdn.net/Jacob_job/article/details/79434207](https://blog.csdn.net/Jacob_job/article/details/79434207)
## 3.3 WebGL
H5使用Canvas来绘图，但是默认的2d模式只能绘制RGB格式，使用FFmpeg解码出来的视频数据是YUV格式，想要渲染出来需要进行颜色空间转换，可以使用FFmpeg的libswscale模块进行转换，为了提升性能，这里使用了WebGL来硬件加速，主要参考了这个项目，做了一些修改：
[https://github.com/p4prasoon/YUV-Webgl-Video-Player](https://github.com/p4prasoon/YUV-Webgl-Video-Player)
## 3.4 Web Audio
FFmpeg解码出来的音频数据是PCM格式，可以使用H5的Web Audio Api来播放，主要参考了这个项目，做了一些修改：
[https://github.com/samirkumardas/pcm-player](https://github.com/samirkumardas/pcm-player)

# 4 播放器实现
这里只是简单实现了播放器的部分功能，包括下载、解封装、解码、渲染、音视频同步等基本功能，每个环节还有很多细节可以优化。seek还没有做，因为涉及的东西比较多。
## 4.1 模块结构
![在这里插入图片描述](https://img-blog.csdnimg.cn/20190207123204349.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L3NvbnlzdXFpbg==,size_16,color_FFFFFF,t_70)
## 4.2 线程模型
理论上来说，播放器应该使用这样的线程模型，各个模块在各自线程各司其职：
![在这里插入图片描述](https://img-blog.csdnimg.cn/20181221114548421.png?x-oss-process=image/watermark,type_ZmFuZ3poZW5naGVpdGk,shadow_10,text_aHR0cHM6Ly9ibG9nLmNzZG4ubmV0L3NvbnlzdXFpbg==,size_16,color_FFFFFF,t_70)
但是WASM目前对多线程(pthread)的支持不够好，各个浏览器的WASM多线程支持还处于试验阶段，因此现在最好不要在原生代码里编写pthread的代码。这里使用了Web Worker，把下载和对FFmpeg的调用放到单独的线程中去。

主要有三个线程：
- 主线程(Player)：界面控制、播放控制、下载控制、音视频渲染、音视频同步；
- 解码线程(Decoder Worker)：音视频数据的解封装、解码；
- 下载线程(Downloader Worker)：下载某个chunk。
线程之间通过postMessage进行异步通信，在需要传输大量数据(例如视频帧)的地方，需要使用Transferable接口来传输，避免大数据的拷贝损耗性能。

## 4.3 Player
### 4.3.1 接口
- play：开始播放；
- pause：暂停播放；
- resume：恢复播放；
- stop：停止播放；
- fullscreen：全屏播放；
- seek：seek播放未实现。
### 4.3.2 下载控制
为防止播放器无限制地下载文件，在下载操作中占用过多的CPU，浪费过多带宽，这里在获取到文件码率之后，以码率一定倍数的速率下载文件。
### 4.3.3 缓冲控制
为防止播放器无限制的解码占用过多的CPU，设置一个已解码视频帧队列长度的阈值，超过阈值则停止解码，队列消耗到一定程度后重启解码。
### 4.3.4 音视频同步
音频数据直接喂给Web Audio，通过Web Audio的Api可以获得当前播放的音频的时间戳，以该时间戳为时间基准来同步视频帧，如果当前视频帧的时间已经落后则立刻渲染，如果比较早，则需要delay。
在H5里delay可以通过setTimeout实现(还未找到更好的方式)，上面做缓冲控制的另外一个意义在于控制视频的渲染频率，如果调用setTimeout的视频帧太多，内存会暴涨。
### 4.3.5 渲染
简单地将PCM数据交给PCM Player，YUV数据交给WebGL Player。
## 4.4 Downloader
这个模块很简单，只是单纯为了不在主线程做太多事情而分离，功能主要有：

- 通过Content-Length字段获取文件的长度；
- 通过Range字段下载一个chunk。

如上面提到的，Player会进行速率控制，因此需要把文件分成chunk，按照chunk方式进行下载。下载的数据先发给Player，由Player转交给Decoder(理论上应该直接交给Decoder，但是Downloader无法直接与Decoder通信)。

## 4.5 Decoder
这个模块需要加载原生代码生成的胶水代码(glue code)，胶水代码会加载wasm。

```
self.importScripts("libffmpeg.js");
```
### 4.5.1 接口
- initDecoder：初始化解码器，开辟文件缓存；
- uninitDecoder：反初始化解码器；
- openDecoder：打开解码器，获取文件信息；
- closeDecoder：关闭解码器；
- startDecoding：开始解码；
- pauseDecoding：暂停解码。 

这些方法都由Player模块通过postMessage异步调用。
### 4.5.2 缓存
这里简单使用了WASM的MEMFS文件接口([WASM的文件系统参考](https://emscripten.org/docs/api_reference/Filesystem-API.html#filesystem-api))，使用方式就是直接调用stdio的方法，然后在emcc的编译命令中加入编译选项：

```
-s FORCE_FILESYSTEM=1 
```
MEMFS会在内存中虚拟一个文件系统，Decoder收到Player发过来的文件数据直接写入缓存，由解码任务读取缓存。

### 4.5.3 解码
- 播放开始后不能立刻打开解码器，因为FFmpeg探测数据格式需要一定的数据长度(例如MP4头的长度)；
- 缓存的数据足够后Player打开解码器，会得到音频的参数(通道数、采样率、采样大小、数据格式)，视频的参数(分辨率，duation、颜色空间)，以这些参数来初始化渲染器、界面；
- Player调用startDecoding会启动一个定时器执行解码任务，以一定的速率开始解码；
- Player缓存满后会调用pauseDecoding暂停解码器。
### 4.5.4 数据交互
解码后的数据直接通过Transferable Objects postMessage给Player，这样传递的是引用，不需要拷贝数据，提高了性能。

Javascript与C的数据交互：

```
发送：
……
this.cacheBuffer = Module._malloc(chunkSize);
……
Decoder.prototype.sendData = function (data) {
    var typedArray = new Uint8Array(data);
    Module.HEAPU8.set(typedArray, this.cacheBuffer); //拷贝
    Module._sendData(this.cacheBuffer, typedArray.length); //传递
};

接收：
this.videoCallback = Module.addFunction(function (buff, size, timestamp) {
    var outArray = Module.HEAPU8.subarray(buff, buff + size); //拷贝
    var data = new Uint8Array(outArray);
    var objData = {
        t: kVideoFrame,
        s: timestamp,
        d: data
    };
    self.postMessage(objData, [objData.d.buffer]); //发送给Player
});
需要把回调通过openDecoder方法传入C层，在C层调用。
```
# 5 编译
## 5.1 安装Emscripten
参考其[官方文档](https://emscripten.org/docs/getting_started/downloads.html)。
## 5.2 下载FFmpeg
```
git clone https://git.ffmpeg.org/ffmpeg.git
```
这里切到了3.3分支。
## 5.3 下载本文的代码
保证FFmpeg目录和代码目录平级。
```
git clone
```
## 5.4 编译
进入代码目录，执行：
```
./build_decoder.sh
```
# 6 测试
可以使用任意的Http Server(Apache、Nginx等)，例如：
如果安装了node/npm/http-server，则在代码目录下执行：

```
http-server -p 8080 .
```
在浏览器输入即可：

```
http://127.0.0.1:8080
```

# 7 浏览器支持
目前没有做太多严格的浏览器兼容性测试，主要在Chrome上开发，以下浏览器比较新的版本都可以运行：

- Chrome(360浏览器、搜狗浏览器等webkit内核也支持)；
- Firefox；
- Edge。
