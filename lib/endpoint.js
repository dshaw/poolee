module.exports = function (inherits, EventEmitter) {
	var MAX_COUNT = Math.pow(2, 31) // largest smi value
	var clock = Date.now()
	setInterval(function () { clock = Date.now() }, 10)
	function noop() { return false }

	//
	// http: either require('http') or require('https')
	// ip: host ip
	// port: host port
	// options: {
	//   ping: ping path (no ping checks)
	//   pingTimeout: in ms (2000)
	//   maxPending: number of requests pending before returning an error (500)
	//   maxSockets: max concurrent open sockets (20)
	//   timeout: default request timeout in ms (60000)
	//   resolution: how often timeouts are checked in ms (1000)
	// }
	function Endpoint(http, ip, port, options) {
		options = options || {}

		this.http = http
		this.ip = ip
		this.port = port
		this.healthy = false
		this.name = this.ip + ':' + this.port
		this.address = this.ip
		this.pingPath = options.ping
		this.pingTimeout = options.pingTimeout || 2000

		this.agent = new http.Agent()
		this.agent.maxSockets = options.maxSockets || 20

		this.requests = {}
		this.requestCount = 0
		this.requestsLastCheck = 0
		this.requestRate = 0
		this.pending = 0
		this.successes = 0
		this.failures = 0

		this.maxPending = options.maxPending || 500
		this.timeout = options.timeout || (60 * 1000)
		this.resolution = options.resolution || 1000
		this.timeoutInterval = setInterval(this.checkTimeouts.bind(this), this.resolution)

		this.ping()
	}
	inherits(Endpoint, EventEmitter)

	Endpoint.prototype.checkTimeouts = function () {
		var keys = Object.keys(this.requests)
		for (var i = 0; i < keys.length; i++) {
			var r = this.requests[keys[i]]
			var expireTime = clock - r.options.timeout
			if (r.lastTouched <= expireTime) {
				this.emit("timeout", r)
				r.abort()
			}
			if (!this.healthy) {
				this.ping()
			}
		}
		this.requestRate = this.requestCount - this.requestsLastCheck
		this.requestsLastCheck = this.requestCount
	}

	Endpoint.prototype.resetCounters = function () {
		this.requestsLastCheck = this.requestRate - this.pending
		this.requestCount = this.pending
		this.successes = 0
		this.failures = 0
	}

	Endpoint.prototype.setPending = function () {
		this.pending = this.requestCount - (this.successes + this.failures)
		if (this.requestCount === MAX_COUNT) {
			this.resetCounters()
		}
	}

	Endpoint.prototype.complete = function (error, request, response, body) {
		this.deleteRequest(request.id)
		this.setPending()
		request.callback(error, response, body)
		request.callback = null
	}

	Endpoint.prototype.succeeded = function (request, response, body) {
		this.successes++
		this.complete(null, request, response, body)
	}

	Endpoint.prototype.failed = function (error, request) {
		this.failures++
		this.complete(error, request)
	}

	Endpoint.prototype.busyness = function () {
		return this.pending
	}

	// options: {
	//   agent:
	//   path:
	//   method:
	//   retryFilter:
	//   timeout: request timeout in ms (this.timeout)
	//   encoding: response body encoding (utf8)
	//   data: string or buffer
	// }
	// callback: function (error, response, body) {}
	Endpoint.prototype.request = function (options, callback) {
		if (this.pending >= this.maxPending && options.path !== this.pingPath) {
			return callback(
				{ reason: 'full'
				, message: 'too many pending requests ' + this.pending + '/' + this.maxPending
				})
		}
		options.host = this.ip
		options.port = this.port
		options.retryFilter = options.retryFilter || noop
		options.timeout = options.timeout || this.timeout
		if (options.agent !== false) {
			options.agent = this.agent
		}
		if (options.encoding !== null) {
			options.encoding = options.encoding || 'utf8'
		}

		var data = options.data
		if (data) {
			options.headers = options.headers || {}
			options.headers["Content-Length"] =
				Buffer.isBuffer(data) ? data.length : Buffer.byteLength(data)
		}
		var req = this.http.request(options)
		req.node = this
		req.options = options
		req.id = this.requestCount++
		req.lastTouched = clock
		req.callback = callback || noop
		req.on('response', gotResponse)
		req.on('error', gotError)
		req.end(data)

		this.setPending()
		this.requests[req.id] = req
	}

	Endpoint.prototype.setHealthy = function (newState) {
		if (this.healthy !== newState) {
			this.healthy = newState
			if (!this.healthy) {
				this.ping() // ping may set this back to healthy
				if (!this.healthy) {
					this.emit('health', this)
				}
			}
			else {
				this.emit('health', this)
			}
		}
	}

	Endpoint.prototype.deleteRequest = function (id) {
		delete this.requests[id]
	}

	function gotPingResponse(error, response, body) {
		this.node.setHealthy(!error && response.statusCode === 200)
	}

	Endpoint.prototype.ping = function () {
		if (this.pingPath) {
			this.request(
				{ path: this.pingPath
				, method: 'GET'
				, timeout: this.pingTimeout
				}
				, gotPingResponse)
		}
		else {
			this.setHealthy(true)
		}
	}

	// this = request
	function gotResponse(response) {
		response.bodyChunks = []
		response.bodyLength = 0
		response.request = this
		response.on('data', gotData)
		response.on('end', gotEnd)
		response.on('aborted', gotAborted)
	}

	// this = request
	function gotError(error) {
		this.node.failed(
			{ reason: error.message
			, attempt: this
			, message: this.node.ip + ':' + this.node.port + ' error: ' + error.message
			}
			, this)
		this.node.setHealthy(false)
	}

	// this = response
	function gotData(chunk) {
		this.request.lastTouched = clock
		this.bodyChunks.push(chunk)
		this.bodyLength += chunk.length
	}

	// this = response
	function gotEnd() {
		var req = this.request
		var opt = req.options
		var node = req.node

		if (req.callback === null) { return }
		node.setHealthy(true)

		var buffer = new Buffer(this.bodyLength)
		var offset = 0
		for (var i = 0; i < this.bodyChunks.length; i++) {
			var chunk = this.bodyChunks[i]
			chunk.copy(buffer, offset, 0, chunk.length)
			offset += chunk.length
		}

		var body = (opt.encoding !== null) ? buffer.toString(opt.encoding) : buffer

		var delay = opt.retryFilter(opt, this, body)
		if (delay !== false) { // delay may be 0
			return node.failed(
			{ delay: delay
			, reason: 'filter'
			, attempt: req
			, message: node.ip + ':' + node.port + ' error: rejected by filter'
			}
			, req)
		}
		node.succeeded(req, this, body)
	}

	// this = response
	function gotAborted() {
		this.request.node.failed(
			{ reason: 'aborted'
			, attempt: this.request
			, message: this.request.node.ip + ':' + this.request.node.port + ' error: connection aborted'
			}
			, this.request)
	}

	return Endpoint
}
