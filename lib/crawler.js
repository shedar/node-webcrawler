'use strict';

var path = require('path');
var util = require('util');
var EventEmitter = require('events').EventEmitter;

var request = require('request');
var _ = require('lodash');
var cheerio = require('cheerio');
var fs = require('fs');
var Pool = require('generic-pool').Pool;
var charsetParser = require('charset-parser');
var Bottleneck = require('bottleneck');
var seenreq = require('seenreq');
var logger=null;
// Fallback on iconv-lite if we didn't succeed compiling iconv
// https://github.com/sylvinus/node-crawler/pull/29
var iconv, iconvLite;
try {
    iconv = require('iconv').Iconv;
} catch (e) {}

if (!iconv) {
    iconvLite = require('iconv-lite');
}

function useCache (options) {
    return (options.uri || options.url) && options.cache;
}

function checkJQueryNaming (options) {
    if ('jquery' in options) {
        options.jQuery = options.jquery;
        delete options.jquery;
    }
    return options;
}

function readJqueryUrl (url, callback) {
    if (url.match(/^(file\:\/\/|\w+\:|\/)/)) {
        fs.readFile(url.replace(/^file\:\/\//,''),'utf-8', function(err,jq) {
            callback(err, jq);
        });
    } else {
        callback(null, url);
    }
}

function Crawler (options) {
    var self = this;
    self.init(options);
}
// augment the prototype for node events using util.inherits
util.inherits(Crawler, EventEmitter);

Crawler.prototype.init = function init (options) {
    var self = this;

    var defaultOptions = {
        autoWindowClose:    true,
        cache:              false,
        forceUTF8:          false,
	gzip:               true,
        incomingEncoding:   null, //TODO remove or optimize
        jQuery:             true,
        maxConnections:     10,
        method:             'GET',
        onDrain:            false,
        priority:           5,
        priorityRange:      10,
        rateLimits:         0,
        referer:            false,
        retries:            3,
        retryTimeout:       10000,
	timeout:            15000,
        skipDuplicates:     false,
	rotateUA:           false
    };

    //return defaultOptions with overriden properties from options.
    self.options = _.extend(defaultOptions, options);

    // you can use jquery or jQuery
    self.options = checkJQueryNaming(self.options);

    if (self.options.rateLimits !== 0 && self.options.maxConnections == 1) {
	//self.options.limiter = "default";
    }else{
	//self.limiters = null;//self.options.maxConnections = 1;
    }
    
    // Don't make these options persist to individual queries
    self.globalOnlyOptions = ['maxConnections', 'priorityRange', 'onDrain'];

    //Setup a worker pool w/ https://github.com/coopernurse/node-pool
    self.pool = Pool({
        name         : 'crawler',
        max          : self.options.maxConnections,
        priorityRange: self.options.priorityRange,
        create       : function(callback) {
            callback(1);
        },
        destroy      : function() {}
    });
    
    self.limiters = new Bottleneck.Cluster(self.options.maxConnections,self.options.rateLimits);
    self.plannedQueueCallsCount = 0;
    self.queueItemSize = 0;

    self.cache = {};
    self.seen = new seenreq();
    logger = self.options.logger || console;

    self.on('pool:release', function(options) {
        self._release(options);
    });
    
    self.on("request",function(options){
	
	if(_.isFunction(self.options.preRequest)){
	    self.options.preRequest(options);
	}
    });
    
    self.on('pool:drain', function() {
        if (self.options.onDrain) {
            self.options.onDrain(self.pool);
        }
    });
};

Crawler.prototype._release = function _release (options) {
    var self = this;

    self.queueItemSize--;
    if (options._poolReference) {
        self.pool.release(options._poolReference);
    }

    // Pool stats are behaving weird - have to implement our own counter
    if (self.queueItemSize + self.plannedQueueCallsCount === 0) {
        self.emit('pool:drain');
    }
};

Crawler.prototype._inject = function _inject (response, options, callback) {
    var $;
    var self = this;

    if (options.jQuery === 'cheerio' || options.jQuery.name === 'cheerio' || options.jQuery === true) {
        var defaultCheerioOptions = {
            normalizeWhitespace: false,
            xmlMode: false,
            decodeEntities: true
        };
        var cheerioOptions = options.jQuery.options || defaultCheerioOptions;
        $ = cheerio.load(response.body, cheerioOptions);

        callback(null, $);
    }

    else if (options.jQuery.jsdom) {
        var jsdom = options.jQuery.jsdom;
        var scriptLocation = path.resolve(__dirname, '../vendor/jquery-2.1.1.min.js');

        //Use promises
        readJqueryUrl(scriptLocation, function(err, jquery) {
            try {
                jsdom.env({
                    url: options.uri,
                    html: response.body,
                    src: [jquery],
                    done: function (errors, window) {
                        $ = window.jQuery;
                        callback(errors, $);

                        try {
                            window.close();
                            window = null;
                        } catch (err) {
                            logger.error(err);
                        }

                    }
                });
            } catch (e) {
                options.callback(e);
                self.emit('pool:release', options);
            }
        });
    }
    // Jquery is set to false are not set
    else {
        callback(null);
    }
};

Crawler.prototype.queue = function queue (options) {
    var self = this;
    
    // Did you get a single object or string? Make it compatible.
    options = _.isString(options) || _.isPlainObject(options) ? [ options ] : options;
    if (_.isArray(options) && options.length == 1) {
        self._pushToQueue(
            _.isString(options[0]) ? { uri: options[0] } : options[0]
        );
    // Did you get multiple requests? Queue the URLs.
    } else if (!_.isNull(options) && !_.isUndefined(options) && options.length>0) {
        self.queue(
            _.isString(options[0]) ? { uri: options[0] } : options[0]
        );
        self.queue(options.slice(1))
    }
};

Crawler.prototype._pushToQueue = function _pushToQueue (options) {
    var self = this;
    self.queueItemSize++;

    // you can use jquery or jQuery
    options = checkJQueryNaming(options);

    _.defaults(options, self.options);

    // Remove all the global options from our options
    // TODO we are doing this for every _pushToQueue, find a way to avoid this
    _.each(self.globalOnlyOptions, function(globalOnlyOption) {
        delete options[globalOnlyOption];
    });

    // If duplicate skipping is enabled, avoid queueing entirely for URLs we already crawled
    if (options.skipDuplicates && self.seen.exists(options)) {
        return self.emit('pool:release', options);
    }

    // acquire connection - callback function is called
    // once a resource becomes available
    // self.pool.acquire(
    var acquired = function(error, poolReference) {
        options._poolReference = poolReference;

        // this is and operation error
        if (error) {
            logger.error(error);
            options.callback(error);
            return;
        }
	
        //Static HTML was given, skip request
        if (options.html) {
            self._onContent(null, options, {body:options.html});
        } else if (typeof options.uri === 'function') {
            options.uri( function(uri) {
                options.uri = uri;
                self._makeCrawlerRequest(options);
            });
        } else {
            self._makeCrawlerRequest(options);
        }
    }//, options.priority);
    
    var acquireWrapped = function(priority,cb){
    	return self.pool.acquire(cb,priority);
    }
    
    self.limiters.key(options.limiter||"default").submit(acquireWrapped,options.priority,acquired);
};

Crawler.prototype._makeCrawlerRequest = function _makeCrawlerRequest (options) {
    var self = this;
    //var cacheData = self.cache[self.seen.normalize(options)];
    
    // if(useCache(options) && cacheData){
    // 	if(options.debug){
    // 	    logger.info("using cache.");
    // 	}
	
    // 	self._onContent(null, options, cacheData, true);
    // 	return;
    // }
    
    // if (typeof options.rateLimits === 'number' && options.rateLimits !== 0) {
    //     setTimeout(function() {
    //         self._buildHttpRequest(options);
    //     }, options.rateLimits);
    // } else {
        self._buildHttpRequest(options);
    // }
};

Crawler.prototype._buildHttpRequest = function _buildHTTPRequest (options) {
    var self = this;

    if (options.debug) {
        logger.info(options.method+' '+options.uri);
    }

    // Cloning keeps the opts parameter clean:
    // - some versions of "request" apply the second parameter as a
    // property called "callback" to the first parameter
    // - keeps the query object fresh in case of a retry
    // Doing parse/stringify instead of _.clone will do a deep clone and remove functions

    var ropts = JSON.parse(JSON.stringify(options));

    if (!ropts.headers) { ropts.headers={}; }
    if (ropts.forceUTF8) {
        // if (!ropts.headers['Accept-Charset'] && !ropts.headers['accept-charset']) {
        //     ropts.headers['Accept-Charset'] = 'utf-8;q=0.7,*;q=0.3';
        // }
	
        ropts.encoding=null;
    }
    
    if (ropts.userAgent) {
	if(ropts.rotateUA && _.isArray(ropts.userAgent)){
	    ropts.headers['User-Agent'] = ropts.userAgent[0];
	    // If "rotateUA" is true, rotate User-Agent
	    options.userAgent.push(options.userAgent.shift());
	}else{
            ropts.headers['User-Agent'] = ropts.userAgent;
	}
	if(options.debug){
	    logger.info(ropts.headers['User-Agent']);
	}
    }
    if (ropts.referer) {
        ropts.headers.Referer = ropts.referer;
    }
    if (ropts.proxies && ropts.proxies.length) {
        ropts.proxy = ropts.proxies[0];
    }
    
    this.emit("request",ropts);

    var requestArgs = ['uri','url','qs','method','headers','body','form','json','multipart','followRedirect',
        'followAllRedirects', 'maxRedirects','encoding','pool','timeout','proxy','auth','oauth','strictSSL',
        'jar','aws','gzip','time','tunnel','proxyHeaderWhiteList','proxyHeaderExclusiveList','localAddress'];

    var req = request(_.pick.apply(this,[ropts].concat(requestArgs)), function(error,response) {
        if (error) {
            return self._onContent(error, options);
        }
	
        response.uri = response.request.href;
        self._onContent(error,options,response);
    });
};

Crawler.prototype._onContent = function _onContent (error, options, response, fromCache) {
    var self = this;

    if (error) {
        if (options.debug) {
            logger.error('Error '+error+' when fetching '+
            options.uri+(options.retries?' ('+options.retries+' retries left)':''));
        }
        if (options.retries) {
            self.plannedQueueCallsCount++;
            setTimeout(function() {
                options.retries--;
                self.plannedQueueCallsCount--;

                // If there is a "proxies" option, rotate it so that we don't keep hitting the same one
                // if (options.proxies) {
                //     options.proxies.push(options.proxies.shift());
                // }
		self.queue(options);
            },options.retryTimeout);

        } else if (options.callback) {
            options.callback(error,{options:options});
        }

        return self.emit('pool:release', options);
    }
    
    if (!response.body) { response.body=''; }

    if (options.debug) {
        logger.info('Got '+(options.uri||'html')+' ('+response.body.length+' bytes)...');
    }

    if(!fromCache){
	try{
            self._doEncoding(options,response);
	}catch(e){
	    logger.error(e);
	    if(options.callback){
		options.callback(e);
	    }
	    return self.emit('pool:release',options);
	}
    }
    
    // if(useCache(options)){
    // 	self.cache[self.seen.normalize(options)] = response;
    // }
    
    if (!options.callback) {
        return self.emit('pool:release', options);
    }

    response.options = options;

    // This could definitely be improved by *also* matching content-type headers
    var isHTML = _.isString(response.body) && response.body.match(/^\s*</);

    if (isHTML && options.jQuery && options.method !== 'HEAD') {
        self._inject(response, options, function(errors, $) {
            self._onInject(errors, options, response, $);
        });
    } else {
        options.callback(null,response);
        self.emit('pool:release', options);
    }
};

Crawler.prototype._doEncoding = function(options,response){
    var self = this;
    
    if(options.encoding === null){
	return;
    }
    
    if (options.forceUTF8) {
        var iconvObj;
	var charset = options.incomingEncoding || self._parseCharset(response);
	
	if (options.debug) {
            logger.info('Charset ' + charset);
        }
	
        if (charset !== 'utf-8' && charset !== 'ascii') {
            if (iconv) {
                iconvObj = new iconv(charset, 'UTF-8//TRANSLIT//IGNORE');
		response.body = iconvObj.convert(response.body).toString();
            } else{
                response.body = iconvLite.decode(response.body, charset);
            }
        }
    }
    
    //if charset = 'utf-8', call toString() ;
    response.body = response.body.toString();
}

Crawler.prototype._onInject = function _onInject (errors, options, response, $) {
    var self = this;
    
    options.callback(errors, response, $);
    self.emit('pool:release', options);
};

Crawler.prototype._parseCharset = function(res){
    var ctt = res.headers['content-type']||res.headers['Content-Type']||'';
    var body = res.body instanceof Buffer?res.body.toString():res.body;
    var charset = charsetParser(ctt,body,'utf-8');
    
    return charset;
}

Object.defineProperty(Crawler.prototype,'queueSize',{
    get:function(){
	return this.pool.waitingClientsCount();
    }
})

module.exports = Crawler;
module.exports.VERSION = '0.6.3';
