const fs = require('fs');
const WebSocket = require('ws');

var host = "0.0.0.0";
var port = 8080;
var filePath = '../video/h265_high.mp4';
var fileSize = -1;

fs.stat(filePath, function(err, stats) {
  fileSize = stats.size;  
});

const wss = new WebSocket.Server({ port: port, host: host});

wss.on('connection', function(ws) {
  var fileFd = null;

  console.log("New connection");

  // Open file.
  fs.open(filePath, 'r', function(err, fd) {
    if (err) {
      console.log("Open " + path + " failed, error " + err);
      return;
    }

    // Save fd.
    fileFd = fd;
    //console.log("File opened");
  });

  ws.on('close', function() {
    console.log("Closed");
    if (fileFd) {
      fs.closeSync(fileFd);
      fileFd = null;
      //console.log("File closed");
    }
  });

  ws.on('error', function(err) {
    console.log("Error " + err);
    if (fileFd) {
      fs.closeSync(fileFd);
      fileFd = null;
      //console.log("File closed");
    }
  });

  ws.on('message', function(message) {
    //console.log(message);
    var cmd = JSON.parse(message);
    if (cmd) {
      if (cmd.cmd == "size") {
        var buffer = Buffer.allocUnsafe(4);
        buffer.writeInt32LE(fileSize);
        ws.send(buffer);
      } else if (cmd.cmd == "data") {
        //console.log("Request data " + cmd.start + "-" + cmd.end);
        var buffer = null,
            chunkSize = 32768,
            byteRead = 0,
            position = null;
        var expectBytes = Math.min(fileSize - cmd.start, cmd.end - cmd.start + 1);
        buffer = Buffer.allocUnsafe(expectBytes);
        //console.log("expect " + expectBytes);
        while (byteRead < expectBytes) {
          //console.log("readSync " + byteRead + ", " + chunkSize + ", " + cmd.start + byteRead);
          let bytesToRead = Math.min(chunkSize, expectBytes - byteRead);
          let bytes = fs.readSync(fileFd, buffer, byteRead, bytesToRead, cmd.start + byteRead);
          if (bytes > 0) {
            byteRead += bytes;
            //console.log("read " + byteRead);
          } else {
            console.log("fs.readSync error " + bytes);
            break;
          }
        };
        //let actualEnd = cmd.start + byteRead - 1;
        //console.log("Sent " + cmd.start + "-" + actualEnd + ", " + byteRead + " bytes.");
        ws.send(buffer);
      } else {
        console.log("Unsupported cmd " + cmd.cmd);
      }
    } else {
      console.log("Invalid cmd " + message);
    }
  });

});

console.log("Listen on %s:%d", host, port)
