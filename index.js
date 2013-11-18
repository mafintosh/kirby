var STATE_RANKS = {running:4, pending:3, stopped:2, 'shutting-down':1, terminated:0};

var getName = function(inst) {
	if (!inst.Tags) return null;
	return inst.Tags.reduce(function(name, tag) {
		return name || (tag.Key === 'Name' && tag.Value);
	}, null);
};

var getGroup = function(inst) {
	var group = inst.SecurityGroups;
	if (!group) return null;
	return group[0] && group[0].GroupName;
};

var noop = function() {};

var parallel = function(callback) {
	var result = [];
	var missing = 0;
	return function() {
		var index = missing++;
		return function(err, value) {
			if (err) {
				var tmp = callback;
				callback = noop;
				tmp(err);
				return;
			}
			result[index+1] = value;
			if (!--missing) callback.apply(null, result);
		};
	};
};

var kirby = function(config) {
	var that = {};
	var AWS = require('aws-sdk');

	if (config) {
		AWS.config.update({
			accessKeyId: config.key,
			secretAccessKey: config.secret,
			region: config.region
		});
	}

	var describeInstances = function(filter, callback) {
		var ec2 = new AWS.EC2();
		ec2.describeInstances(function(err, instances) {
			if (err) return callback(err);

			var result = [];
			instances.Reservations.forEach(function(res) {
				result = result.concat(res.Instances);
			});

			if (!filter) return callback(null, result);

			result = result.filter(function(inst) {
				if (inst.InstanceId === filter) return true;
				return (inst.Tags || []).some(function(tag) {
					return tag.Key === 'Name' && tag.Value === filter;
				});
			});

			callback(null, result);
		});
	};

	that.describe = function(callback) {
		var ec2 = new AWS.EC2();
		var iam = new AWS.IAM();
		var elb = new AWS.ELB();

		var describeZones = function(callback) {
			ec2.describeAvailabilityZones(function(err, result) {
				if (err) return callback(err);

				var zones = result.AvailabilityZones.map(function(zone) {
					return zone.ZoneName;
				});

				callback(null, zones);
			});
		};

		var describeGroups = function(callback) {
			ec2.describeSecurityGroups(function(err, result) {
				if (err) return callback(err);

				var groups = result.SecurityGroups.map(function(group) {
					return group.GroupName;
				});

				callback(null, groups);
			});
		};

		var describeKeys = function(callback) {
			ec2.describeKeyPairs(function(err, result) {
				if (err) return callback(err);

				var keys = result.KeyPairs.map(function(key) {
					return key.KeyName;
				});

				callback(null, keys);
			});
		};

		var describeRoles = function(callback) {
			iam.listInstanceProfiles(function(err, result) {
				if (err) return callback(err);

				var roles = result.InstanceProfiles.map(function(role) {
					return role.InstanceProfileName;
				});

				callback(null, roles);
			});
		};

		var describeLoadBalancers = function(callback) {
			elb.describeLoadBalancers(function(err, elbs) {
				if (err) return callback(err);

				elbs = elbs.LoadBalancerDescriptions.map(function(elb) {
					return elb.LoadBalancerName;
				});

				callback(null, elbs);
			});
		};

		var wait = parallel(function(err, loadBalancers, roles, zones, keys, groups) {
			if (err) return callback(err);

			callback(null, {
				loadBalancers:loadBalancers,
				iamRoles:roles,
				availabilityZones:zones,
				keyNames:keys,
				securityGroups:groups
			});
		});

		describeLoadBalancers(wait());
		describeRoles(wait());
		describeZones(wait());
		describeKeys(wait());
		describeGroups(wait());
	};

	that.instances = function(filter, opts, callback) {
		if (typeof filter === 'function') return that.instances(null, null, filter);
		if (typeof opts === 'function') return that.instances(filter, null, opts);
		if (!opts) opts = {};

		var wait = parallel(function(err, instances, loadBalancers) {
			if (err) return callback(err);

			instances = instances
				.map(function(inst) {
					return {
						instanceId: inst.InstanceId,
						name: getName(inst),
						loadBalancer: loadBalancers[inst.InstanceId],
						publicDns: inst.PublicDnsName,
						instanceType: inst.InstanceType,
						securityGroup: getGroup(inst),
						iamRole: inst.IamInstanceProfile && inst.IamInstanceProfile.Arn.split('/').pop(),
						launchTime: inst.LaunchTime,
						instanceState: inst.State.Name,
						availabilityZone: inst.Placement.AvailabilityZone,
						keyName: inst.KeyName,
						ami: inst.ImageId
					}
				})
				.sort(function(a, b) {
					var stateA = a.instanceState;
					var stateB = b.instanceState;
					if (stateA !== 'running' || stateB !== 'running') return (STATE_RANKS[stateB] || 0) - (STATE_RANKS[stateA] || 0);
					return b.launchTime.getTime() - a.launchTime.getTime();
				});

			if (opts.running) {
				instances = instances.filter(function(inst) {
					return inst.instanceState === 'running';
				});
			}

			callback(null, instances);
		});

		var instanceToLoadBalancer = function(callback) {
			var elb = new AWS.ELB();
			elb.describeLoadBalancers(function(err, loadBalancers) {
				if (err) return callback(err);
				var map = {};
				loadBalancers.LoadBalancerDescriptions.forEach(function(elb) {
					if (!elb.Instances) return;
					elb.Instances.forEach(function(inst) {
						map[inst.InstanceId] = elb.LoadBalancerName;
					});
				});
				callback(null, map);
			});
		};

		describeInstances(filter, wait());
		instanceToLoadBalancer(wait());
	};

	that.hostnames = function(filter, callback) {
		if (typeof filter === 'function') return that.hostnames(null, filter);

		that.instances(filter, function(err, instances) {
			if (err) return callback(err);

			var hostnames = instances
				.map(function(inst) {
					return inst.state === 'running' && inst.publicDns;
				})
				.filter(function(hostname) {
					return hostname;
				});

			callback(null, hostnames);
		});
	};

	that.exec = function(filter, opts) {
		if (typeof filter === 'object' && filter) return that.exec(null, filter);
		if (!opts) opts = {};

		var Connection = require('ssh2');
		var stream = require('stream-wrapper');
		var thunky = require('thunky');

		var buffers = [];
		var duplex = stream.duplex(noop, function(buffer, enc, callback) {
			buffers.push(buffer);
			callback();
		});

		duplex.on('finish', function() {
			buffers = Buffer.concat(buffers).toString();

			that.hostnames(filter, function(err, hostnames) {
				if (err) return duplex.emit('error', err);

				var connects = hostnames.map(function(hostname) {
					var connect = thunky(function(callback) {
						var c = new Connection();

						c.on('error', callback);
						c.on('ready', function() {
							c.removeListener('error', callback);
							callback(null, c);
						});

						c.connect({
							username: opts.user || 'ubuntu',
							host: hostname,
							port: opts.port || 22,
							privateKey: opts.key
						});
					});

					return connect;
				});

				if (opts.one) connects = connects.slice(0, 1);

				var call = function(fn) {
					fn();
				};

				var loop = function() {
					var connect = connects.shift();
					if (!connect) return duplex.push(null);

					if (opts.pool !== false) connects.slice(0, 3).forEach(call); // preheat

					connect(function(err, c) {
						if (err) return duplex.emit('error', err);

						c.on('error', function(err) {
							duplex.emit('error', err);
						});

						c.exec(buffers, function(err, stream) {
							if (err) return duplex.emit('error', err);

							stream.on('data', function(data) {
								duplex.push(data);
							});

							stream.on('exit', function() {
								c.end();
								loop();
							});
						});
					});
				};

				loop();
			});
		});

		return duplex;
	};

	that.script = function(filter, callback) {
		if (typeof filter === 'function') return that.script(null, filter);

		that.instances(filter, function(err, instances) {
			if (err) return callback(err);
			if (!instances.length) return callback();

			var id = instances[0].instanceId;
			var ec2 = new AWS.EC2();
			ec2.describeInstanceAttribute({
				InstanceId: id,
				Attribute: 'userData'
			}, function(err, result) {
				if (err) return callback(err);
				if (!result.UserData || !result.UserData.Value) return callback();

				callback(null, new Buffer(result.UserData.Value, 'base64').toString());
			});
		});
	};

	// filter MUST be specified for launch
	that.launch = function(filter, opts, callback) {
		if (typeof opts === 'function') return that.launch(filter, null, opts);
		if (typeof filter === 'function' || !filter) throw new Error('Name of instance id must be specified');
		if (!opts) opts = {};
		if (!callback) callback = noop;

		var xtend = require('xtend');
		var ec2 = new AWS.EC2();
		var elb = new AWS.ELB();

		if (opts.defaults) opts.name = filter;

		var ensureZone = function(callback) {
			if (opts.availabilityZone) return callback();
			if (!opts.loadBalancer) return callback();

			elb.describeLoadBalancers({LoadBalancerNames:[opts.loadBalancer]}, function(err, result) {
				if (err) return callback(err);
				var defaultZones = result ? result.LoadBalancerDescriptions[0].AvailabilityZones : [];
				opts.availabilityZone = defaultZones[Math.floor(Math.random() * defaultZones.length)];
				callback();
			});
		};

		var onlaunched = function(id) {
			var lookup = function(callback) {
				that.instances(id, function(err, instances) {
					if (err) return callback(err);
					callback(null, instances[0]);
				});
			};

			if (!opts.wait) return lookup(callback);

			var wait = function() {
				lookup(function(err, instance) {
					if (err) return callback(err);
					if (instance.instanceState === 'running') return callback(null, instance);
					setTimeout(wait, 2000);
				});
			};

			wait();
		};

		var launch = function() {
			if (!opts.ami) return callback(new Error('ami is required'));

			var name = opts.name || filter;
			var conf = {};

			conf.ImageId = opts.ami;
			conf.MinCount = conf.MaxCount = opts.count || 1;

			ensureZone(function(err) {
				if (err) return callback(err);

				if (opts.keyName) conf.KeyName = opts.keyName;
				if (opts.securityGroup) conf.SecurityGroups = [].concat(opts.securityGroup);
				if (opts.script) conf.UserData = new Buffer(opts.script, 'utf-8').toString('base64');
				if (opts.instanceType) conf.InstanceType = opts.instanceType;
				if (opts.availabilityZone) conf.Placement = {AvailabilityZone: opts.availabilityZone};
				if (opts.iamRole) conf.IamInstanceProfile = {Name: opts.iamRole};

				ec2.runInstances(conf, function(err, result) {
					if (err) return callback(err);

					var id = result.Instances[0].InstanceId;
					ec2.createTags({
						Resources: [id],
						Tags: [{
							Key: 'Name',
							Value: name
						}]
					}, function(err) {
						if (err) return callback(err);
						if (!opts.loadBalancer) return onlaunched(id);

						elb.registerInstancesWithLoadBalancer({
							LoadBalancerName:opts.loadBalancer,
							Instances:[id]
						}, function(err) {
							if (err) return callback(err);
							onlaunched(id);
						});
					});
				});
			});
		};

		if (opts.defaults === false) return launch();

		that.instances(opts.defaults || filter, function(err, instances) {
			if (err) return callback(err);
			if (!instances.length) return launch();

			var inst = instances[0];

			delete inst.availabilityZone;
			opts = xtend(inst, opts);

			if (opts.script) return launch();
			that.script(inst.instanceId, function(err, script) {
				if (err) return callback(err);
				opts.script = script;
				launch();
			});

		});
	};

	// filter MUST be specified for terminate
	that.terminate = function(filter, callback) {
		if (!callback) callback = noop;
		if (!filter) throw new Error('Name of instance id must be specified');

		that.instances(filter, function(err, instances) {
			if (err) return callback(err);

			var inst = instances[0];
			if (!inst) return callback();

			var ec2 = new AWS.EC2();
			ec2.terminateInstances({InstanceIds:[inst.instanceId]}, function(err, result) {
				if (err) return callback(err);
				inst.instanceState = result.TerminatingInstances[0].CurrentState.Name;
				callback(null, inst);
			});
		});
	};

	return that;
};

module.exports = kirby;