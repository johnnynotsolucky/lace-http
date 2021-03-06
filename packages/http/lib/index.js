const { createServer } = require('http')
const { Stream } = require('stream')
const { Observable, Subject, of, throwError, pipe } = require('rxjs')
const { mergeMap, catchError, map, multicast } = require('rxjs/operators')

const { readable } = require('is-stream')

const { NODE_ENV } = process.env
const DEV = NODE_ENV === 'development'

const IS_RESPONSE = Symbol('is-response')

const isResponseObject = o => !!o[IS_RESPONSE]

const createServerObservable = onCreate =>
  new Observable(observer => {
    try {
      const server = createServer((req, res) => observer.next({ req, res }))
      server.on('close', () => observer.complete())
      onCreate(server)
    } catch (err) {
      observer.error(err)
    }
  })

const prepareResponse = o => {
  if (isResponseObject(o)) {
    return o
  }

  return {
    statusCode: 200,
    headers: {},
    data: o,
  }
}

// https://github.com/zeit/micro/blob/master/lib/index.js#L28
const sendResponse = (res, response) => {
  const { data, headers, statusCode } = response

  res.statusCode = statusCode

  if (data === null) {
    res.end()
    return
  }

  Object.keys(headers).forEach(header => res.setHeader(header, headers[header]))

  if (Buffer.isBuffer(data)) {
    if (!res.getHeader('Content-Type')) {
      res.setHeader('Content-Type', 'application/octet-stream')
    }

    res.setHeader('Content-Length', data.length)
    res.end(data)
    return
  }

  if (data instanceof Stream || readable(data)) {
    if (!res.getHeader('Content-Type')) {
      res.setHeader('Content-Type', 'application/octet-stream')
    }

    data.pipe(res)
    return
  }

  let str = data

  if (typeof data === 'object' || typeof data === 'number') {
    if (DEV) {
      str = JSON.stringify(data, null, 2)
    } else {
      str = JSON.stringify(data)
    }

    if (!res.getHeader('Content-Type')) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
    }
  }

  res.setHeader('Content-Length', Buffer.byteLength(str))
  res.end(str)
}

const send = (data, statusCode = 200, headers = []) => {
  return {
    [IS_RESPONSE]: true,
    data,
    statusCode,
    headers,
  }
}

const prepareErrorResponse = e => {
  const error =
    e instanceof ResponseError
      ? e
      : createError(500, 'Internal Server Error', e)

  console.error(error.originalError ? error.originalError.stack : error.stack)

  return send(error.message, error.statusCode)
}

class ResponseError extends Error {
  constructor(code, message, originalError) {
    super(message)
    this.statusCode = code
    this.originalError = originalError
  }
}

const createError = (code, message, originalError) =>
  new ResponseError(code, message, originalError)

const mapToObservable = f =>
  pipe((...x) => {
    try {
      const result = f(...x)
      return result instanceof Observable ? result : of(result)
    } catch (err) {
      return throwError(err)
    }
  })

const run = (handler, request$$) =>
  request$$.pipe(
    mergeMap(({ req, res }) =>
      of({ req, res }).pipe(
        mapToObservable(handler),
        map(val => [{ req, res }, null, val]),
        catchError(err => of([{ req, res }, err, null])),
      ),
    ),
    multicast(() => new Subject()),
  )

const serve = handler => {
  const listen = (port, onListen) => {
    const request$ = run(
      handler,
      createServerObservable(server =>
        server.listen(port, () => {
          if (onListen) {
            onListen(server)
          }
        }),
      ),
    )

    request$.connect()
    request$.subscribe(([{ req, res }, err, val]) => {
      if (err) {
        sendResponse(res, prepareErrorResponse(err))
      } else if (val !== undefined) {
        // Allow through all falsy values with the exception of `undefined`
        sendResponse(res, prepareResponse(val))
      }
    })

    return request$
  }

  return listen
}

module.exports = serve

serve.default = serve
serve.send = send
serve.createError = createError
