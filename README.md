[![build status](https://secure.travis-ci.org/bda-research/node-webcrawler.png)](https://travis-ci.org/bda-research/node-webcrawler)
node-webcrawler
------------

node-webcrawler is originally a fork of [node-crawler](https://github.com/sylvinus/node-crawler) which aims to be the best crawling/scraping package for Node.

0.5.0 version changelog:
 * parse charset from `content-type` in http headers or meta tag in html, then convert
 * big5 charset is avaliable as the `iconv-lite` has already supported it 
 * default enable gzip in request header
 * remove unzip code in crawler since `request` will do this
 * body will return as a Buffer if encoding is null which is an option in `request`
 * remove cache and skip duplicate `request` for `GET`, `POST`(only for type `urlencode`), `HEAD`
 * add log feature, you can use `winston` to set `logger:winston`, or crawler will output to console
 * rotate user-agent in case some sites ban your requests
 
0.5.1 version changelog:
 * remove cache feature, it's useless
 * add `localAddress`, `time`, `tunnel`, `proxyHeaderWhiteList`, `proxyHeaderExclusiveList` properties to pass to `request`

0.5.2 version changelog:
 * you can manually terminate all the resources in your pool before their timeouts have been reached
 * add a read-only property `queueSize` to crawler
 
0.6.0 version changelog:
 * add `bottleneck` to implement rate limit, one can set limit for each connection at same time.
 
0.6.3 version changelog:
 * you could also get `result.options` from callback even when some errors ouccurred
 * add test for `bottleneck`

 
Features:
 * server-side DOM & automatic jQuery insertion with Cheerio (default) or JSDOM
 * Configurable pool size and retries
 * Priority of requests
 * forceUTF8 mode to let crawler deal for you with charset detection and conversion

Help & Forks welcomed!

How to install
--------------

    $ npm install node-webcrawler

Crash course
------------

```javascript
var Crawler = require("node-webcrawler");
var url = require('url');

var c = new Crawler({
    maxConnections : 10,
    // This will be called for each crawled page
    callback : function (error, result, $) {
        // $ is Cheerio by default
        //a lean implementation of core jQuery designed specifically for the server
        $('a').each(function(index, a) {
            var toQueueUrl = $(a).attr('href');
            c.queue(toQueueUrl);
        });
    }
});

// Queue just one URL, with default callback
c.queue('http://joshfire.com');

// Queue a list of URLs
c.queue(['http://jamendo.com/','http://tedxparis.com']);

// Queue URLs with custom callbacks & parameters
c.queue([{
    uri: 'http://parishackers.org/',
    jQuery: false,

    // The global callback won't be called
    callback: function (error, result) {
        console.log('Grabbed', result.body.length, 'bytes');
    }
}]);

// Queue using a function
var googleSearch = function(search) {
  return 'http://www.google.fr/search?q=' + search;
};
c.queue({
  uri: googleSearch('cheese')
});

// Queue some HTML code directly without grabbing (mostly for tests)
c.queue([{
    html: '<p>This is a <strong>test</strong></p>'
}]);
```

Options reference
-----------------

You can pass these options to the Crawler() constructor if you want them to be global or as
items in the queue() calls if you want them to be specific to that item (overwriting global options)

This options list is a strict superset of [mikeal's request options](https://github.com/mikeal/request#requestoptions-callback) and will be directly passed to
the request() method.

Basic request options:

 * `uri`: String, the URL you want to crawl
 * `timeout` : Number, in milliseconds        (Default 15000)
 * [All mikeal's requests options are accepted](https://github.com/mikeal/request#requestoptions-callback)

Callbacks:

 * `callback(error, result, $)`: A request was completed
 * `onDrain(pool)`: There is no more queued requests, call `pool.destroyAllNow()` if you wanna release resources in pool to, or if you have follow-up tasks to queue you can ignore.

Pool options:

 * `maxConnections`: Number, Size of the worker pool (Default 10),
 * `priorityRange`: Number, Range of acceptable priorities starting from 0 (Default 10),
 * `priority`: Number, Priority of this request (Default 5),

Retry options:

 * `retries`: Number of retries if the request fails (Default 3),
 * `retryTimeout`: Number of milliseconds to wait before retrying (Default 10000),

Server-side DOM options:

 * `jQuery`: true, false or ConfObject (Default true)

Charset encoding:

 * `forceUTF8`: Boolean, if true will get charset from HTTP headers or meta tag in html and convert it to UTF8 if necessary. Never worry about encoding anymore! (Default false),
 * `incomingEncoding`: String, with forceUTF8: true to set encoding manually (Default null)
     `incomingEncoding : 'windows-1255'` for example

Cache:

 * `cache`: Boolean, if true stores requests' result in memory (Default false), not recommend if you are doing with huge amount of pages as the process will exhaust momery
 * `skipDuplicates`: Boolean, if true skips URIs that were already crawled, without even calling callback() (Default false)

Other:
 * `rotateUA`: Boolean, if true, `userAgent` should be an array, and rotate it (Default false) 
 * `userAgent`: String or Array, if `rotateUA` is false, but `userAgent` is array, will use first one. defaults to "node-crawler/[version]"
 * `referer`: String, if truthy sets the HTTP referer header
 * `rateLimits`: Number of milliseconds to delay between each requests (Default 0) 

 
Class:Crawler
-------------

Instance of Crawler

__crawler.queue(uri|options)__
 * `uri` String, `options` is [Options](#options-reference)

__crawler.queueSize__

Size of queue, read-only

 
Working with Cheerio or JSDOM
-----------------------------

Crawler by default use [Cheerio](https://github.com/cheeriojs/cheerio) instead of [Jsdom](https://github.com/tmpvar/jsdom). Jsdom is more robust but can be hard to install (espacially on windows) because of [contextify](https://github.com/tmpvar/jsdom#contextify).
Which is why, if you want to use jsdom you will have to build it, and `require('jsdom')` in your own script before passing it to crawler. This is to avoid cheerio crawler user to build jsdom when installing crawler.

###Working with Cheerio
```javascript
jQuery: true //(default)
//OR
jQuery: 'cheerio'
//OR
jQuery: {
    name: 'cheerio',
    options: {
        normalizeWhitespace: true,
        xmlMode: true
    }
}
```
These parsing options are taken directly from [htmlparser2](https://github.com/fb55/htmlparser2/wiki/Parser-options), therefore any options that can be used in `htmlparser2` are valid in cheerio as well. The default options are:

```js
{
    normalizeWhitespace: false,
    xmlMode: false,
    decodeEntities: true
}
```

For a full list of options and their effects, see [this](https://github.com/fb55/DomHandler) and
[htmlparser2's options](https://github.com/fb55/htmlparser2/wiki/Parser-options).
[source](https://github.com/cheeriojs/cheerio#loading)

###Working with JSDOM

In order to work with JSDOM you will have to install it in your project folder `npm install jsdom`, deal with [compiling C++](https://github.com/tmpvar/jsdom#contextify) and pass it to crawler.
```javascript
var jsdom = require('jsdom');
var Crawler = require('node-webcrawler');

var c = new Crawler({
    jQuery: jsdom
});
```

How to test
-----------

### Install and run Httpbin

node-webcrawler use a local httpbin for testing purpose. You can install httpbin as a library from PyPI and run it as a WSGI app. For example, using Gunicorn:

    $ pip install httpbin
    // launch httpbin as a daemon with 6 worker on localhost
    $ gunicorn httpbin:app -b 127.0.0.1:8000 -w 6 --daemon

    // Finally
    $ npm install && npm test

### Alternative: Docker

After [installing Docker](http://docs.docker.com/), you can run:

    // Builds the local test environment
    $ docker build -t node-webcrawler .

    // Runs tests
    $ docker run node-webcrawler sh -c "gunicorn httpbin:app -b 127.0.0.1:8000 -w 6 --daemon && npm install && npm test"

    // You can also ssh into the container for easier debugging
    $ docker run -i -t node-webcrawler bash

    
[![build status](https://secure.travis-ci.org/bda-research/node-webcrawler.png)](https://travis-ci.org/bda-research/node-webcrawler)

Rough todolist
--------------

 * Using bottleneck to deal with rate limits
 * Introducing zombie to deal with page with complex ajax
 * Refactoring the code to be more maintenable, it's spaghetti code in there !
 * Proxy feature
 * This issue: https://github.com/sylvinus/node-crawler/issues/118
 * Make Sizzle tests pass (jsdom bug? https://github.com/tmpvar/jsdom/issues#issue/81)
 * More crawling tests
 * Document the API more (+ the result object)
 * Option to wait for callback to finish before freeing the pool resource (via another callback like next())


ChangeLog
---------

See https://github.com/bda-research/node-webcrawler/releases
