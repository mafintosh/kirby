var fs = require('fs');
var path = require('path');

var HOME = process.env.HOME || process.env.USERPROFILE;
var AWS_FOLDER = path.join(HOME, '.aws');
var AWS_CONFIG = path.join(AWS_FOLDER, 'config');
var AWS_CACHE = path.join(AWS_FOLDER, 'cache.json');
var TTL = 24 * 3600 * 1000;

try {
	fs.mkdirSync(AWS_FOLDER);
} catch (err) {
	// do nothing
}

var config = '';
try {
	config = fs.readFileSync(AWS_CONFIG, 'utf-8').trim();
} catch (err) {
	// do nothing
}

var cache = {};
try {
	cache = require(AWS_CACHE);
} catch (err) {
	// do nothing
}

var profiles = config.split(/\[(?:profile )?/)
	.map(function(profile) {
		profile = profile.trim();
		if (!profile) return null;

		var match = function(regex) {
			return (profile.match(regex) || [])[1];
		};

		var name = match(/(^.+)]/);

		return {
			name: name,
			access: match(/aws_access_key_id\s*=\s*(.+)/),
			secret: match(/aws_secret_access_key\s*=\s+(.+)/),
			region: match(/region\s*=\s*(.+)/),
			cache: function(key, value) {
				key = name+'.'+key;
				var now = Date.now();
				if (arguments.length === 1) return cache[key] && now < cache[key].mtime + TTL && cache[key].value;
				cache[key] = {mtime:now, value:value};
				fs.writeFileSync(AWS_CACHE, JSON.stringify(cache, null, '  '));
				return value;
			}
		};
	})
	.filter(function(profile) {
		return profile;
	});

exports.names = function() {
	return profiles.map(function(profile) {
		return profile.name;
	});
};

exports.save = function(profile) {
	var format = function(profile) {
		var str = ''+
			(profile.name === 'default' ? '[default]\n' : '[profile '+profile.name+']\n') +
			'aws_access_key_id = '+profile.access+'\n'+
			'aws_secret_access_key = '+profile.secret+'\n'+
			'region = '+profile.region+'\n\n';

		return str;
	};

	var i = -1;
	profiles.some(function(old, index) {
		if (old.name !== profile.name) return;
		i = index;
		return true;
	});

	if (i === -1) profiles.push(profile);
	else profiles[i] = profile;

	fs.writeFileSync(AWS_CONFIG, profiles.map(format).join(''));
	return exports.get(profile.name);
};

exports.get = function(name) {
	if (!name) name = 'default';
	return profiles.reduce(function(result, profile) {
		return result || (profile.name === name && profile);
	}, null);
};